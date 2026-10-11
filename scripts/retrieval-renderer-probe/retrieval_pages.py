"""Bounded PDF-page rendering for explicit local image retrieval indexing."""
import argparse
import json
import math
import os
import tempfile
import sys
from pathlib import Path


def limit_memory(max_bytes):
    """Apply an OS-enforced allocation ceiling before loading any native library."""
    if sys.platform == 'linux':
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (max_bytes, max_bytes))
        return None
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        class BasicLimits(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                        ('flags', wintypes.DWORD), ('min_working_set', ctypes.c_size_t),
                        ('max_working_set', ctypes.c_size_t), ('active_processes', wintypes.DWORD),
                        ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]
        class ExtendedLimits(ctypes.Structure):
            _fields_ = [('basic', BasicLimits), ('io', IoCounters), ('process_memory', ctypes.c_size_t),
                        ('job_memory', ctypes.c_size_t), ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            raise OSError('memory-limit-unavailable')
        limits = ExtendedLimits()
        limits.basic.flags = 0x100  # JOB_OBJECT_LIMIT_PROCESS_MEMORY
        limits.process_memory = max_bytes
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            kernel.CloseHandle(job)
            raise OSError('memory-limit-unavailable')
        return job  # Keep the job handle live until this worker exits.
    raise OSError('memory-limit-unavailable')


class BoundedOutput:
    """Reject each encoded write before disk usage can exceed the allocation."""
    def __init__(self, stream, maximum):
        self.stream, self.maximum = stream, maximum

    def write(self, data):
        if self.stream.tell() + len(data) > self.maximum:
            raise ValueError('Rendered pixels exceed output byte budget')
        return self.stream.write(data)

    def flush(self):
        return self.stream.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('--max-pages', type=int, required=True)
    parser.add_argument('--max-pixels', type=int, required=True)
    parser.add_argument('--max-bytes', type=int, required=True)
    parser.add_argument('--max-total-bytes', type=int, required=True)
    parser.add_argument('--max-memory-bytes', type=int, required=True)
    args = parser.parse_args()
    if min(args.max_pages, args.max_pixels, args.max_bytes, args.max_total_bytes, args.max_memory_bytes) <= 0:
        raise ValueError('Positive raster limits required')
    memory_guard = limit_memory(args.max_memory_bytes)
    import importlib.metadata
    if importlib.metadata.version('pypdfium2') != '4.30.0' or importlib.metadata.version('Pillow') != '12.3.0':
        raise RuntimeError('PDF raster runtime differs from the pinned preprocessing profile')
    import pypdfium2 as pdfium
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    document = pdfium.PdfDocument(args.source)
    try:
        if len(document) > args.max_pages:
            raise ValueError('PDF exceeds the explicitly configured page limit')
        paths = []
        total = 0
        for index in range(len(document)):
            page = document[index]
            bitmap = image = None
            try:
                width, height = page.get_size()
                if width <= 0 or height <= 0 or not math.isfinite(width * height):
                    raise ValueError('Invalid PDF page geometry')
                scale = min(1.5, math.sqrt(args.max_pixels / (width * height)))
                while math.ceil(width * scale) * math.ceil(height * scale) > args.max_pixels:
                    scale *= .99
                bitmap = page.render(scale=scale)
                image = bitmap.to_pil().convert('RGB')
                if image.width * image.height > args.max_pixels:
                    raise ValueError('Rendered page exceeds pixel limit')
                target = output / ('page-%d.png' % (index + 1))
                fd, temporary_name = tempfile.mkstemp(prefix='page-', suffix='.png', dir=output)
                temporary = Path(temporary_name)
                try:
                    with os.fdopen(fd, 'wb') as stream:
                        image.save(BoundedOutput(stream, min(args.max_bytes, args.max_total_bytes - total)), format='PNG')
                    size = temporary.stat().st_size
                    if size > args.max_bytes or total + size > args.max_total_bytes:
                        raise ValueError('Rendered pages exceed byte budget')
                    total += size
                    temporary.replace(target)
                finally:
                    temporary.unlink(missing_ok=True)
                paths.append(str(target))
            finally:
                if image is not None:
                    image.close()
                if bitmap is not None:
                    bitmap.close()
                page.close()
        print(json.dumps(paths))
    finally:
        document.close()


if __name__ == '__main__':
    main()
