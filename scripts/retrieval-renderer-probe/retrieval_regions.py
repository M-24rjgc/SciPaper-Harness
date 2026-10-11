"""Bounded visual crops in top-left, normalized, intrinsically rotated display space."""
import argparse
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import tempfile
import warnings


def crop(image, region, maximum):
    """Round outward to include the selected pixels; clamp to displayed bounds."""
    width, height = image.size
    if width * height > maximum:
        raise ValueError('Decoded source exceeds pixel budget')
    left = math.floor(region['x'] * width)
    top = math.floor(region['y'] * height)
    right = min(width, math.ceil((region['x'] + region['width']) * width))
    bottom = min(height, math.ceil((region['y'] + region['height']) * height))
    return image.crop((left, top, right, bottom)), (left, top, right, bottom)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('--kind', choices=['pdf', 'image'], required=True)
    parser.add_argument('--page', type=int, required=True)
    parser.add_argument('--region', required=True)
    for name in ['max-pages', 'max-pixels', 'max-bytes', 'max-memory-bytes']:
        parser.add_argument('--' + name, type=int, required=True)
    args = parser.parse_args()
    if min(args.max_pages, args.max_pixels, args.max_bytes, args.max_memory_bytes, args.page) <= 0:
        raise ValueError('Positive limits required')
    region = json.loads(args.region)
    if set(region) != {'x', 'y', 'width', 'height'} or any(type(value) not in (int, float) or not math.isfinite(value) for value in region.values()):
        raise ValueError('Invalid normalized display region')
    if region['x'] < 0 or region['y'] < 0 or region['width'] <= 0 or region['height'] <= 0 or region['x'] + region['width'] > 1 or region['y'] + region['height'] > 1:
        raise ValueError('Region outside normalized display coordinates')
    spec = importlib.util.spec_from_file_location("retrieval_pages", Path(__file__).resolve().with_name("retrieval_pages.py"))
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    memory_guard = renderer.limit_memory(args.max_memory_bytes)
    if importlib.metadata.version('pypdfium2') != '4.30.0' or importlib.metadata.version('Pillow') != '12.3.0':
        raise RuntimeError('Region runtime differs from pinned preprocessing profile')
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = args.max_pixels
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    document = page = bitmap = original = image = cropped = None
    temporary = None
    try:
        if args.kind == 'pdf':
            import pypdfium2 as pdfium
            document = pdfium.PdfDocument(args.source)
            if len(document) > args.max_pages or args.page > len(document):
                raise ValueError('PDF page outside configured page budget')
            page = document[args.page - 1]
            width, height = page.get_size()  # PDFium includes intrinsic page rotation.
            if min(width, height) <= 0 or not math.isfinite(width * height):
                raise ValueError('Invalid PDF page geometry')
            scale = min(1.5, math.sqrt(args.max_pixels / (width * height)))
            while math.ceil(width * scale) * math.ceil(height * scale) > args.max_pixels:
                scale *= .99
            bitmap = page.render(scale=scale)
            image = bitmap.to_pil().convert('RGB')
        else:
            if args.page != 1:
                raise ValueError('Image has no PDF page number')
            original = Image.open(args.source)
            if original.width * original.height > args.max_pixels or getattr(original, 'n_frames', 1) != 1:
                raise ValueError('Image exceeds decode budget or has multiple frames')
            image = ImageOps.exif_transpose(original).convert('RGB')
        cropped, pixels = crop(image, region, args.max_pixels)
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='region-', suffix='.png', dir=target.parent)
        temporary = Path(name)
        with os.fdopen(fd, 'wb') as stream:
            cropped.save(renderer.BoundedOutput(stream, args.max_bytes), format='PNG')
        temporary.replace(target)
        print(json.dumps({'width': cropped.width, 'height': cropped.height, 'displayWidth': image.width, 'displayHeight': image.height, 'pixelBounds': pixels}))
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        for resource in [cropped, image, original, bitmap, page, document]:
            if resource is not None:
                resource.close()


if __name__ == '__main__':
    main()
