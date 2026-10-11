"""Opt-in native CI evidence for the shipped worker; no download or paid API calls."""
import argparse
import base64
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import time
import zlib


def png(width=32, height=32):
    """Create a deterministic RGB sample without imaging dependencies."""
    def chunk(name, data):
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
    pixels = (b'\x00' + b'\xdc\x1e\x1e' * width) * height
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', required=True, help='Extracted pinned native wheel directory')
    parser.add_argument('--model', required=True, help='Already hash-verified pinned model file')
    parser.add_argument('--variant', choices=('text', 'vision'), required=True)
    parser.add_argument('--cache', required=True)
    parser.add_argument('--memory-bytes', type=int, default=8589934592)
    options = parser.parse_args()
    Path(options.cache).mkdir(parents=True, exist_ok=True)
    worker = Path(__file__).resolve().parent.parent / 'runtime' / 'worker.py'
    args = [sys.executable, '-I', str(worker), options.runtime, options.model, options.cache, options.variant,
            '2', '16777216', '8192', '8388608', '64', '16777216', str(options.memory_bytes)]
    samples = [{'inputId': 'emotion', 'kind': 'text', 'text': 'Speech emotion recognition classifies emotional states from acoustic signals.'},
               {'inputId': 'graph', 'kind': 'text', 'text': 'A graph neural network aggregates messages from neighboring nodes.'}]
    if options.variant == 'vision':
        samples.append({'inputId': 'image', 'kind': 'image', 'mediaType': 'image/png', 'data': base64.b64encode(png()).decode()})
    request = {'spaceId': 'native-ci-space', 'purpose': 'document', 'inputs': samples}
    started = time.perf_counter()
    result = subprocess.run(args, input=json.dumps(request), capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, (result.returncode, result.stderr[-4096:])
    response = json.loads(result.stdout)
    assert 'error' not in response, response
    assert response['spaceId'] == request['spaceId'] and len(response['results']) == len(samples)
    for row in response['results']:
        vector = row['vector']
        assert len(vector) == 768 and all(math.isfinite(v) for v in vector)
        assert abs(math.sqrt(sum(v*v for v in vector)) - 1) < 0.001
    elapsed = time.perf_counter() - started
    # The next generation works after owned termination; no prior result is reused.
    child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        child.stdin.write(json.dumps(request).encode())
        child.stdin.close()
        time.sleep(0.1)
        child.kill()
        child.wait(timeout=15)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=15)
        child.stdout.close()
        child.stderr.close()
    repeated = subprocess.run(args, input=json.dumps(request), capture_output=True, text=True, timeout=120)
    assert repeated.returncode == 0 and 'results' in json.loads(repeated.stdout), repeated.stderr[-4096:]
    oversized = dict(request, inputs=[{'inputId': 'oversize', 'kind': 'text', 'text': 'x' * 8193}])
    rejected = subprocess.run(args, input=json.dumps(oversized), capture_output=True, text=True, timeout=120)
    assert json.loads(rejected.stdout) == {'error': 'invalid-input'}, rejected.stdout
    print(json.dumps({'variant': options.variant, 'memoryLimitBytes': options.memory_bytes, 'seconds': elapsed,
                      'rows': len(samples), 'dimensions': 768, 'cancelledProcessExited': True, 'restartVerified': True,
                      'oversizeRejected': True, 'scope': 'synthetic plumbing only, not retrieval quality'}))


if __name__ == '__main__':
    main()
