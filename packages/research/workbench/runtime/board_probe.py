"""Read-only machine status for the experiment board. Uses only the Python standard library.

Reads one JSON argument, {"disk": path, "progress": [run directories], "limit": rows},
and prints the machine's processors, memory, GPUs and disk, plus the progress lines of
the named runs. Nothing is written anywhere.
"""
import csv
import json
import math
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import time

SAMPLE_SECONDS = 0.25
PROGRESS_BYTES = 16 * 1024 * 1024
PROGRESS_FIELDS = 40


def number(text):
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def read(path):
    try:
        return Path(path).read_text(errors='replace').strip()
    except OSError:
        return None


def gpus():
    query = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit'
    try:
        result = subprocess.run(['nvidia-smi', '--query-gpu=' + query, '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=8)
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    found = []
    for row in csv.reader(result.stdout.splitlines()):
        if len(row) < 7:
            continue
        name, util, used, total, temperature, power, limit = (cell.strip() for cell in row[:7])
        found.append({'name': name, 'util': number(util), 'memoryUsed': number(used), 'memoryTotal': number(total),
                      'temperature': number(temperature), 'power': number(power), 'powerLimit': number(limit)})
    return found


def cgroup_quota():
    """Processors a cgroup v2 CPU quota allows, or None without one."""
    text = read('/sys/fs/cgroup/cpu.max')
    if not text:
        return None
    parts = text.split()
    if len(parts) < 2 or parts[0] == 'max':
        return None
    quota, period = number(parts[0]), number(parts[1])
    return quota / period if quota and period else None


def cgroup_usage():
    for line in (read('/sys/fs/cgroup/cpu.stat') or '').splitlines():
        if line.startswith('usage_usec'):
            return number(line.split()[1])
    return None


def proc_times():
    fields = (read('/proc/stat') or '').splitlines()[:1]
    if not fields or not fields[0].startswith('cpu '):
        return None
    values = [number(value) or 0 for value in fields[0].split()[1:]]
    idle = values[3] + (values[4] if len(values) > 4 else 0)
    return idle, sum(values)


def windows_times():
    import ctypes
    idle, kernel, user = (ctypes.c_ulonglong() for _ in range(3))
    if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
        return None
    # Kernel time includes idle time.
    return idle.value, kernel.value + user.value


def cpu():
    cores = os.cpu_count()
    quota = cgroup_quota()
    if quota:
        first, start = cgroup_usage(), time.monotonic()
        time.sleep(SAMPLE_SECONDS)
        second, elapsed = cgroup_usage(), time.monotonic() - start
        if first is not None and second is not None:
            return {'util': min(1, max(0, (second - first) / (elapsed * 1e6 * quota))), 'cores': quota}
    sample = windows_times if os.name == 'nt' else proc_times
    try:
        first = sample()
        time.sleep(SAMPLE_SECONDS)
        second = sample()
    except (OSError, AttributeError, ValueError):
        return {'cores': cores}
    if not first or not second or second[1] <= first[1]:
        return {'cores': cores}
    busy = 1 - (second[0] - first[0]) / (second[1] - first[1])
    return {'util': min(1, max(0, busy)), 'cores': cores}


def memory():
    if os.name == 'nt':
        import ctypes

        class Status(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong), ('total', ctypes.c_ulonglong), ('available', ctypes.c_ulonglong),
                        ('pageTotal', ctypes.c_ulonglong), ('pageAvailable', ctypes.c_ulonglong), ('virtualTotal', ctypes.c_ulonglong),
                        ('virtualAvailable', ctypes.c_ulonglong), ('extended', ctypes.c_ulonglong)]
        status = Status()
        status.length = ctypes.sizeof(Status)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
        return {'used': status.total - status.available, 'total': status.total}
    limit = number(read('/sys/fs/cgroup/memory.max'))
    current = number(read('/sys/fs/cgroup/memory.current'))
    if limit and current is not None:
        return {'used': current, 'total': limit}
    info = {}
    for line in (read('/proc/meminfo') or '').splitlines():
        key, _, rest = line.partition(':')
        info[key] = (number(rest.split()[0]) if rest.split() else None)
    if info.get('MemTotal') and info.get('MemAvailable') is not None:
        return {'used': (info['MemTotal'] - info['MemAvailable']) * 1024, 'total': info['MemTotal'] * 1024}
    return None


def disk(path):
    target = Path(path).expanduser() if path else Path.cwd()
    while not target.exists() and target.parent != target:
        target = target.parent
    try:
        usage = shutil.disk_usage(str(target))
    except OSError:
        return None
    return {'path': str(target), 'used': usage.used, 'total': usage.total, 'free': usage.free}


def thin(rows, limit):
    """At most `limit` rows, evenly spaced, always keeping the last."""
    if len(rows) <= limit:
        return rows
    step = len(rows) / limit
    return [rows[int(index * step)] for index in range(limit - 1)] + [rows[-1]]


def progress(directory, limit):
    path = Path(directory) / 'progress.jsonl'
    try:
        with path.open('rb') as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - PROGRESS_BYTES))
            lines = stream.read().decode('utf-8', errors='replace').splitlines()
    except OSError:
        return []
    rows = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            values = {key: value for key, value in row.items() if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)}
            if values:
                rows.append(dict(list(values.items())[:PROGRESS_FIELDS]))
    return thin(rows, limit)


def main():
    request = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    limit = int(request.get('limit', 400))
    report = {'host': socket.gethostname(), 'os': platform.platform(terse=True), 'gpus': gpus(), 'cpu': cpu(), 'memory': memory(),
              'disk': disk(request.get('disk')), 'progress': {directory: progress(directory, limit) for directory in request.get('progress', [])}}
    print(json.dumps(report, ensure_ascii=True, allow_nan=False))


if __name__ == '__main__':
    main()
