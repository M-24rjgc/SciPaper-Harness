"""Cross-platform synthetic evidence for the exact product PDF renderer and hard resource limits."""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
RENDERER = ROOT / 'retrieval_pages.py'
MEMORY = 2147483648


def synthetic_pdf(path, pages=1):
    """A self-contained vector PDF with deterministic colored content and exact xref offsets."""
    contents = b'0.8 0.1 0.2 rg 20 20 560 740 re f\n0.1 0.2 0.8 rg 40 40 250 300 re f\n'
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               ('<< /Type /Pages /Kids [%s] /Count %d >>' % (' '.join('%d 0 R' % (3 + index*2) for index in range(pages)), pages)).encode()]
    for index in range(pages):
        objects.append(('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents %d 0 R >>' % (4 + index*2)).encode())
        objects.append(('<< /Length %d >>\nstream\n' % len(contents)).encode() + contents + b'endstream')
    data = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data)); data.extend(('%d 0 obj\n' % index).encode() + obj + b'\nendobj\n')
    start = len(data)
    data.extend(('xref\n0 %d\n0000000000 65535 f \n' % len(offsets)).encode())
    for offset in offsets[1:]:
        data.extend(('%010d 00000 n \n' % offset).encode())
    data.extend(('trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(offsets), start)).encode())
    path.write_bytes(data)


def arguments(source, output, **limits):
    settings = {'max-pages': 2, 'max-pixels': 100000, 'max-bytes': 1048576, 'max-total-bytes': 2097152, 'max-memory-bytes': MEMORY}
    settings.update(limits)
    return [sys.executable, '-I', str(RENDERER), str(source), str(output)] + [part for name, value in settings.items() for part in ('--' + name, str(value))]


def guard_only():
    spec = importlib.util.spec_from_file_location('renderer', RENDERER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    guard = module.limit_memory(MEMORY)
    try:
        bytearray(MEMORY + 1073741824)
        raise AssertionError('Allocation exceeded renderer memory cap')
    except MemoryError:
        print(json.dumps({'memoryDenied': True, 'capBytes': MEMORY}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--guard-only', action='store_true')
    parser.add_argument('--output', default=os.environ.get('RENDERER_PROBE_DIR', str(ROOT / 'results')))
    options = parser.parse_args()
    if options.guard_only:
        guard_only(); return
    output = Path(options.output); output.mkdir(parents=True, exist_ok=True)
    lock = json.loads((ROOT / 'lock.json').read_text())
    digest = hashlib.sha256(RENDERER.read_bytes()).hexdigest()
    assert digest == lock['rendererSha256'], 'Renderer changed after the probe snapshot'
    region_digest = hashlib.sha256((ROOT / 'retrieval_regions.py').read_bytes()).hexdigest()
    assert region_digest == lock['regionRendererSha256'], 'Region renderer changed after snapshot'
    region_test = subprocess.run([sys.executable, '-I', str(ROOT / 'test_retrieval_regions.py')], capture_output=True, text=True, timeout=120)
    assert region_test.returncode == 0 and 'Ran 1 test' in region_test.stderr and 'OK' in region_test.stderr, region_test.stderr
    assert sys.version_info[:2] == (3, 12)
    assert importlib.metadata.version('pypdfium2') == '4.30.0'
    assert importlib.metadata.version('Pillow') == '12.3.0'
    import io
    module_spec = importlib.util.spec_from_file_location('renderer', RENDERER)
    renderer = importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(renderer)
    bounded_stream = io.BytesIO(); bounded = renderer.BoundedOutput(bounded_stream, 4)
    bounded.write(b'abcd')
    try:
        bounded.write(b'e'); raise AssertionError('bounded writer accepted excess data')
    except ValueError:
        assert bounded_stream.getvalue() == b'abcd'
    source = output / 'synthetic.pdf'; synthetic_pdf(source)
    started = time.perf_counter()
    result = subprocess.run(arguments(source, output / 'pages'), capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr[-4096:]
    paths = json.loads(result.stdout); assert len(paths) == 1
    from PIL import Image
    with Image.open(paths[0]) as image:
        image.load()
        width, height = image.size
        assert image.format == 'PNG' and width * height <= 100000
        assert image.convert('RGB').getextrema() != ((255, 255), (255, 255), (255, 255))
    bytes_written = Path(paths[0]).stat().st_size
    assert bytes_written <= 1048576
    elapsed = time.perf_counter() - started
    two = output / 'two-pages.pdf'; synthetic_pdf(two, 2)
    broken = output / 'broken.pdf'; broken.write_bytes(b'not a PDF')
    cases = [('page-limit', two, {'max-pages': 1}), ('single-byte-limit', source, {'max-bytes': 1}),
             ('total-byte-limit', source, {'max-total-bytes': 1}), ('invalid-pdf', broken, {})]
    rejected = []
    for name, pdf, limits in cases:
        destination = output / name
        bad = subprocess.run(arguments(pdf, destination, **limits), capture_output=True, text=True, timeout=60)
        assert bad.returncode != 0, name + ' unexpectedly succeeded'
        assert not list(destination.glob('*.png')), name + ' published partial pixels'
        rejected.append(name)
    memory = subprocess.run([sys.executable, '-I', __file__, '--guard-only'], capture_output=True, text=True, timeout=30)
    assert memory.returncode == 0 and json.loads(memory.stdout)['memoryDenied'], memory.stderr[-4096:]
    child = subprocess.Popen(arguments(source, output / 'cancelled'), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        time.sleep(0.05)
        child.kill(); child.wait(timeout=15)
    finally:
        if child.poll() is None:
            child.kill(); child.wait(timeout=15)
        child.stdout.close(); child.stderr.close()
    repeated = subprocess.run(arguments(source, output / 'restart'), capture_output=True, text=True, timeout=60)
    assert repeated.returncode == 0 and len(json.loads(repeated.stdout)) == 1, repeated.stderr[-4096:]
    report = {'platform': platform.platform(), 'python': platform.python_version(), 'rendererSha256': digest, 'regionRendererSha256': region_digest, 'exactRotatedCropAndLimitsVerified': True,
              'pypdfium2': '4.30.0', 'Pillow': '12.3.0', 'memoryLimitBytes': MEMORY, 'memoryDenialVerified': True,
              'width': width, 'height': height, 'pixels': width * height, 'bytes': bytes_written, 'seconds': elapsed,
              'rejected': rejected, 'cancelledProcessExited': True, 'restartVerified': True,
              'scope': 'synthetic bounded-renderer plumbing; not document extraction or retrieval quality'}
    (output / 'renderer-result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
