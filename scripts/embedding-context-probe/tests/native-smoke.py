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
            '2', '16777216', '8192', '8388608', '64', '16777216', str(options.memory_bytes), '8192']
    samples = [{'inputId': 'emotion', 'kind': 'text', 'text': 'Speech emotion recognition classifies emotional states from acoustic signals.'},
               {'inputId': 'graph', 'kind': 'text', 'text': 'A graph neural network aggregates messages from neighboring nodes.'}]
    samples.append({'inputId': 'long-context', 'kind': 'text', 'text': 'token ' * 1200})
    if options.variant == 'vision':
        samples.append({'inputId': 'image', 'kind': 'image', 'mediaType': 'image/png', 'data': base64.b64encode(png()).decode()})
        samples.append({'inputId': 'jpeg', 'kind': 'image', 'mediaType': 'image/jpeg', 'data': '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlqKKK8M/VAooooAKKKKACiiigD//Z'})
        samples.append({'inputId': 'webp', 'kind': 'image', 'mediaType': 'image/webp', 'data': 'UklGRkwAAABXRUJQVlA4IEAAAABQAwCdASogACAAPm00lkekIyIhKAgAgA2JZQC29oAAQOJeAAD+7ylH/gN18WuX/+5wP+5wP+5wP4rID8Q6ugAA'})
    request = {'spaceId': 'native-ci-space', 'purpose': 'document', 'inputs': samples}
    started = time.perf_counter()
    result = subprocess.run(args, input=json.dumps(request), capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, (result.returncode, result.stderr[-4096:])
    response = json.loads(result.stdout)
    if 'error' in response:
        # Only these committed synthetic fixtures are used: diagnose media independently.
        failures = []
        for sample in samples:
            diagnostic = subprocess.run(args, input=json.dumps(dict(request, inputs=[sample])), capture_output=True, text=True, timeout=120)
            payload = json.loads(diagnostic.stdout) if diagnostic.returncode == 0 else {'error': 'process-exit'}
            failures.append({'inputId': sample['inputId'], 'error': payload.get('error'), 'stderr': diagnostic.stderr[-4096:] if 'error' in payload else ''})
        raise AssertionError({'batch': response, 'syntheticDiagnostics': failures})
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
                      'maxInputTokens': 8192, 'rows': len(samples), 'dimensions': 768, 'cancelledProcessExited': True, 'restartVerified': True,
                      'oversizeRejected': True, 'scope': 'synthetic plumbing only, not retrieval quality'}))


if __name__ == '__main__':
    main()
