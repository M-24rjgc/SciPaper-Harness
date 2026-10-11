"""Keyless real-runtime regression: pinned PDF/image crop geometry and resource failures."""
import importlib.metadata
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

RUNTIME = Path(__file__).resolve().parent
try:
    PINNED = importlib.metadata.version('pypdfium2') == '4.30.0' and importlib.metadata.version('Pillow') == '12.3.0'
except importlib.metadata.PackageNotFoundError:
    PINNED = False


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


@unittest.skipUnless(PINNED, 'Requires pinned managed pypdfium2 4.30.0 and Pillow 12.3.0')
class RegionRuntimeTest(unittest.TestCase):
    def test_real_rotated_pdf_and_image_limits(self):
        from PIL import Image, ImageChops
        import pypdfium2 as pdfium
        with tempfile.TemporaryDirectory(prefix='region-regression-') as directory:
            root = Path(directory)
            source = root / 'source.pdf'
            synthetic_pdf(source)
            document = pdfium.PdfDocument(source)
            page = document[0]
            page.set_rotation(90)
            page.close()
            rotated = root / 'rotated.pdf'
            document.save(rotated)
            document.close()
            def run(path, kind, name='crop.png', pixels=100000, byte_limit=1000000, page_number=1, region=None):
                return subprocess.run([sys.executable, '-I', str(RUNTIME / 'retrieval_regions.py'), str(path), str(root / name),
                    '--kind', kind, '--page', str(page_number), '--region', json.dumps(region or {'x': 0, 'y': 0, 'width': .5, 'height': .5}),
                    '--max-pages', '2', '--max-pixels', str(pixels), '--max-bytes', str(byte_limit),
                    '--max-memory-bytes', '2147483648'], capture_output=True, text=True, timeout=30)
            result = run(rotated, 'pdf')
            self.assertEqual(result.returncode, 0, result.stderr)
            metadata = json.loads(result.stdout)
            self.assertGreater(metadata['displayWidth'], metadata['displayHeight'])
            self.assertEqual(metadata['width'], (metadata['displayWidth'] + 1) // 2)
            self.assertLessEqual(metadata['displayWidth'] * metadata['displayHeight'], 100000)
            document = pdfium.PdfDocument(rotated)
            page = document[0]
            width, height = page.get_size()
            scale = min(1.5, math.sqrt(100000 / (width * height)))
            while math.ceil(width * scale) * math.ceil(height * scale) > 100000:
                scale *= .99
            bitmap = page.render(scale=scale)
            full = bitmap.to_pil().convert('RGB')
            expected = full.crop(tuple(metadata['pixelBounds']))
            with Image.open(root / 'crop.png') as actual:
                difference = ImageChops.difference(actual, expected)
                self.assertIsNone(difference.getbbox())
                difference.close()
            expected.close(); full.close(); bitmap.close(); page.close(); document.close()

            with Image.new('RGB', (20, 10), 'red') as image:
                image.paste('blue', (10, 0, 20, 10))
                image.save(root / 'image.png')
            result = run(root / 'image.png', 'image')
            self.assertEqual(result.returncode, 0, result.stderr)
            with Image.open(root / 'crop.png') as image:
                self.assertEqual(image.size, (10, 5))
                self.assertEqual(image.getpixel((0, 0)), (255, 0, 0))
            for result in [run(rotated, 'pdf', 'bad.png', page_number=3),
                           run(rotated, 'pdf', 'bad.png', byte_limit=8),
                           run(root / 'image.png', 'image', 'bad.png', pixels=10),
                           run(rotated, 'pdf', 'bad.png', region={'x': .9, 'y': 0, 'width': .5, 'height': 1})]:
                self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'bad.png').exists())
            self.assertFalse(list(root.glob('region-*.png')))


if __name__ == '__main__':
    unittest.main()
