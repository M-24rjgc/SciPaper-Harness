"""Independent, idempotent experiment jobs. Uses only the Python standard library."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp.' + str(os.getpid()))
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    for attempt in range(40):
        try:
            os.replace(temporary, path)
            break
        except PermissionError:
            if attempt == 39:
                raise
            time.sleep(.025)


def read_json(path):
    for attempt in range(40):
        try:
            with Path(path).open(encoding='utf-8') as stream:
                return json.load(stream)
        except PermissionError:
            if attempt == 39:
                raise
            time.sleep(.025)


def identity(pid):
    """Return the OS process birth identity, preventing cancellation after PID reuse."""
    if os.name == 'nt':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return None
        try:
            creation, exit_time, kernel_time, user_time = (ctypes.c_ulonglong() for _ in range(4))
            if not kernel.GetProcessTimes(ctypes.c_void_p(handle), ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(kernel_time), ctypes.byref(user_time)):
                return None
            return str(creation.value)
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        fields = Path('/proc/{}/stat'.format(pid)).read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            return None
        return fields[19]
    except (OSError, IndexError):
        return None


def inspect(directory):
    directory = Path(directory)
    state_file = directory / 'state.json'
    if not state_file.exists():
        return {'status': 'unknown', 'message': 'Submission outcome has not been confirmed'}
    state = read_json(state_file)
    if state['status'] in ('running', 'queued'):
        pid = state.get('runnerPid')
        birth = state.get('runnerIdentity')
        if pid and birth and identity(pid) != birth:
            state.update(status='interrupted', message='Experiment supervisor exited or the machine restarted', updatedAt=time.time())
            atomic_json(state_file, state)
        elif not pid and time.time() - state['updatedAt'] > 30:
            state.update(status='interrupted', message='Supervisor did not start; this submission will not be replayed automatically', updatedAt=time.time())
            atomic_json(state_file, state)
    return state


def collect_outputs(written, collected):
    """Copy a script's cwd-relative outputs/ into the run's outputs/, where they are collected as evidence."""
    written, collected = Path(written).resolve(), Path(collected).resolve()
    if written == collected or not written.is_dir():
        return
    for path in written.rglob('*'):
        target = collected / path.relative_to(written)
        if path.is_file() and not path.name.startswith('.') and not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())


def terminate(child):
    if child.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    else:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    child.wait(timeout=15)


def worker(directory):
    directory = Path(directory).resolve()
    spec = read_json(directory / 'spec.json')
    state = {'status': 'running', 'runnerPid': os.getpid(), 'runnerIdentity': identity(os.getpid()), 'startedAt': time.time(), 'updatedAt': time.time(), 'message': '', 'metrics': {}}
    atomic_json(directory / 'state.json', state)
    child = None
    try:
        environment = {key: value for key, value in os.environ.items() if not any(secret in key.upper() for secret in ('KEY', 'SECRET', 'TOKEN', 'PASSWORD'))}
        for key in ('PYTHONPATH', 'PYTHONHOME', 'ELECTRON_RUN_AS_NODE'):
            environment.pop(key, None)
        outputs = directory / 'outputs'
        outputs.mkdir(exist_ok=True)
        environment.update(CUDA_VISIBLE_DEVICES=','.join(spec['gpuIds']), PYTHONUNBUFFERED='1', PYTHONHASHSEED=str(spec['seed']), RESEARCH_RUN_DIR=str(directory), RESEARCH_OUTPUT_DIR=str(outputs), RESEARCH_SEED=str(spec['seed']), RESEARCH_METRICS_PATH=str(directory / 'metrics.json'))
        arguments = [spec['python'] if argument == '{python}' else argument for argument in spec['argv']]
        options = {'cwd': spec['cwd'], 'env': environment, 'stdin': subprocess.DEVNULL}
        if os.name == 'nt':
            options['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        else:
            options['start_new_session'] = True
        with (directory / 'stdout.log').open('ab', buffering=0) as stdout, (directory / 'stderr.log').open('ab', buffering=0) as stderr:
            child = subprocess.Popen(arguments, stdout=stdout, stderr=stderr, **options)
            state.update(pid=child.pid, childIdentity=identity(child.pid))
            atomic_json(directory / 'state.json', state)
            while child.poll() is None:
                elapsed = time.time() - state['startedAt']
                if (directory / 'cancel.request').exists() or elapsed > spec['maxSeconds']:
                    terminate(child)
                    state['status'] = 'cancelled' if elapsed <= spec['maxSeconds'] else 'failed'
                    state['message'] = 'Cancelled by user' if elapsed <= spec['maxSeconds'] else 'Run exceeded its maxSeconds limit'
                    break
                state['updatedAt'] = time.time()
                atomic_json(directory / 'state.json', state)
                time.sleep(0.5)
            code = child.wait()
            state['exitCode'] = code
            if state['status'] == 'running':
                state['status'] = 'completed' if code == 0 else 'failed'
            collect_outputs(Path(spec['cwd']) / 'outputs', outputs)
            metrics_path = directory / 'metrics.json'
            if not metrics_path.exists():
                candidate = (Path(spec['cwd']) / spec['metricsPath']).resolve()
                if candidate.is_relative_to(Path(spec['cwd']).resolve()) and candidate.exists() and candidate.stat().st_mtime >= state['startedAt']:
                    metrics_path = candidate
            if metrics_path.exists():
                values = read_json(metrics_path)
                if not isinstance(values, dict) or any(not isinstance(value, (int, float)) or isinstance(value, bool) for value in values.values()):
                    raise ValueError('metrics.json must be an object of finite numeric values')
                json.dumps(values, allow_nan=False)
                state['metrics'] = values
                atomic_json(directory / 'metrics.json', values)
    except Exception as error:
        if child is not None:
            terminate(child)
        state.update(status='failed', message=str(error))
    finally:
        state.update(updatedAt=time.time(), finishedAt=time.time())
        atomic_json(directory / 'state.json', state)


def launch(directory):
    directory = Path(directory).resolve()
    try:
        (directory / 'submission.lock').mkdir()
    except FileExistsError:
        return inspect(directory)
    atomic_json(directory / 'state.json', {'status': 'queued', 'updatedAt': time.time(), 'message': 'Independent supervisor starting', 'metrics': {}})
    options = {'stdin': subprocess.DEVNULL, 'cwd': str(directory)}
    if os.name == 'nt':
        # A hidden console, not none: a virtual environment's python.exe starts the real interpreter, which opens a
        # visible console when its parent has none (DETACHED_PROCESS). Windows ignores CREATE_NO_WINDOW beside DETACHED_PROCESS.
        options['creationflags'] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options['start_new_session'] = True
    with (directory / 'supervisor.log').open('ab', buffering=0) as log:
        try:
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'worker', str(directory)], stdout=log, stderr=log, **options)
        except Exception as error:
            atomic_json(directory / 'state.json', {'status': 'failed', 'updatedAt': time.time(), 'message': str(error), 'metrics': {}})
            raise
    for _ in range(40):
        result = inspect(directory)
        if result['status'] != 'queued':
            return result
        time.sleep(0.05)
    return inspect(directory)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['launch', 'worker', 'status', 'cancel'])
    parser.add_argument('directory')
    args = parser.parse_args()
    if args.action == 'worker':
        worker(args.directory)
        return
    if args.action == 'launch':
        result = launch(args.directory)
    elif args.action == 'cancel':
        result = inspect(args.directory)
        if result['status'] in ('running', 'queued'):
            Path(args.directory, 'cancel.request').touch(exist_ok=True)
            result['message'] = 'Cancellation requested; waiting for supervisor confirmation'
    else:
        result = inspect(args.directory)
    print(json.dumps(result, ensure_ascii=True, allow_nan=False))


if __name__ == '__main__':
    main()
