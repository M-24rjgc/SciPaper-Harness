"""Extract a host-verified, dependency-free wheel into an owned empty directory."""
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


def install(wheel, target, max_bytes):
    """Reject archive links, escaping paths and expansion over the host budget."""
    target = Path(target)
    total = 0
    with zipfile.ZipFile(wheel) as archive:
        for entry in archive.infolist():
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename or ':' in entry.filename or stat.S_ISLNK(mode):
                raise ValueError('Unsafe wheel member')
            total += entry.file_size
            if total > max_bytes:
                raise ValueError('Wheel expansion exceeds disk budget')
            destination = target.joinpath(*path.parts)
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with archive.open(entry) as source, destination.open('xb') as output:
                os.chmod(destination, 0o600)
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
    print(json.dumps({'installed': True}), flush=True)


if __name__ == '__main__':
    try:
        install(sys.argv[1], sys.argv[2], int(sys.argv[3]))
    except Exception:
        print(json.dumps({'error': 'integrity'}), flush=True)
        sys.exit(1)
