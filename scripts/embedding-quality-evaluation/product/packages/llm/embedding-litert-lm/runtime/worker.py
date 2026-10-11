"""Private one-batch CPU embedding process. Only host-authorized bytes cross stdin."""
import base64
import json
import math
import os
import sys
import struct


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


def check_image(data, media_type, max_pixels):
    """Bound declared raster dimensions before the isolated native decoder allocates."""
    dimensions = []
    if media_type == 'image/png':
        if len(data) < 33 or data[:8] != b'\x89PNG\r\n\x1a\n' or data[8:16] != b'\x00\x00\x00\rIHDR':
            raise ValueError('invalid-png')
        dimensions.append(struct.unpack('>II', data[16:24]))
        offset = 8
        while offset + 12 <= len(data):
            length = int.from_bytes(data[offset:offset + 4], 'big')
            if length > len(data) - offset - 12 or data[offset + 4:offset + 8] == b'acTL':
                raise ValueError('invalid-or-animated-png')
            offset += length + 12
        if offset != len(data):
            raise ValueError('invalid-png-chunks')
    elif media_type == 'image/jpeg':
        if data[:2] != b'\xff\xd8':
            raise ValueError('invalid-jpeg')
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 0xff:
                raise ValueError('invalid-jpeg-marker')
            marker = data[offset + 1]
            if marker == 0xff:
                offset += 1
                continue
            size = int.from_bytes(data[offset + 2:offset + 4], 'big')
            if size < 2 or offset + size + 2 > len(data):
                raise ValueError('invalid-jpeg-segment')
            if marker in (0xc0, 0xc1, 0xc2):
                if size < 8:
                    raise ValueError('invalid-jpeg-frame')
                height, width = struct.unpack('>HH', data[offset + 5:offset + 9])
                dimensions.append((width, height))
                break
            offset += size + 2
    elif media_type == 'image/webp':
        if len(data) < 20 or data[:4] != b'RIFF' or data[8:12] != b'WEBP' or int.from_bytes(data[4:8], 'little') + 8 != len(data):
            raise ValueError('invalid-webp')
        offset = 12
        while offset + 8 <= len(data):
            kind = data[offset:offset + 4]
            size = int.from_bytes(data[offset + 4:offset + 8], 'little')
            start = offset + 8
            if start + size > len(data):
                raise ValueError('invalid-webp-chunk')
            if kind == b'VP8X' and size >= 10:
                if data[start] & 2:
                    raise ValueError('animated-webp')
                dimensions.append((int.from_bytes(data[start + 4:start + 7], 'little') + 1, int.from_bytes(data[start + 7:start + 10], 'little') + 1))
            elif kind == b'VP8L' and size >= 5 and data[start] == 0x2f:
                bits = int.from_bytes(data[start + 1:start + 5], 'little')
                dimensions.append(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            elif kind == b'VP8 ' and size >= 10 and data[start + 3:start + 6] == b'\x9d\x01\x2a':
                dimensions.append((int.from_bytes(data[start + 6:start + 8], 'little') & 0x3fff, int.from_bytes(data[start + 8:start + 10], 'little') & 0x3fff))
            elif kind in (b'ANIM', b'ANMF'):
                raise ValueError('animated-webp')
            offset = start + size + (size & 1)
        if offset != len(data):
            raise ValueError('invalid-webp-chunks')
    if not dimensions or any(width < 1 or height < 1 or width * height > max_pixels for width, height in dimensions):
        raise ValueError('image-dimensions')


def run(args):
    """Read one bounded request, load the pinned runtime and emit one bounded result."""
    runtime, model, cache, variant, threads, max_request, max_text, max_image, max_batch, max_pixels, max_memory = args
    memory_guard = limit_memory(int(max_memory))
    limit = int(max_request)
    raw = sys.stdin.buffer.read(limit + 1)
    if len(raw) > limit:
        raise ValueError('request-limit')
    request = json.loads(raw)
    inputs = request['inputs']
    if request['purpose'] not in ('query', 'document') or not isinstance(inputs, list) or len(inputs) > int(max_batch):
        raise ValueError('invalid-request')
    # The host provides only its private extracted wheel, never user-selected Python code.
    sys.path.insert(0, runtime)
    from litert_lm import Backend, Content, EmbeddingEngine, EmbeddingOptions, InputOverflowStrategy
    extra = {'vision_backend': Backend.CPU(thread_count=int(threads))} if variant == 'vision' else {}
    options = EmbeddingOptions(normalize=True, input_overflow_strategy=InputOverflowStrategy.ERROR)
    results = []
    with EmbeddingEngine(model, backend=Backend.CPU(thread_count=int(threads)), cache_dir=cache, **extra) as engine:
        for item in inputs:
            if item['kind'] == 'text':
                text = item['text']
                if not isinstance(text, str) or not text.strip() or len(text.encode('utf-8')) > int(max_text):
                    raise ValueError('text-limit')
                prefix = 'task: search query | text: ' if request['purpose'] == 'query' else 'task: search result | text: '
                contents = prefix + text
            elif item['kind'] == 'image' and variant == 'vision':
                if item['mediaType'] not in ('image/png', 'image/jpeg', 'image/webp'):
                    raise ValueError('image-type')
                data = base64.b64decode(item['data'], validate=True)
                if not data or len(data) > int(max_image):
                    raise ValueError('image-limit')
                check_image(data, item['mediaType'], int(max_pixels))
                contents = Content.ImageBytes(data)
            else:
                raise ValueError('unsupported-input')
            vector = engine.compute_embedding(contents, options=options).embedding
            if len(vector) != 768 or not all(math.isfinite(v) for v in vector) or abs(math.sqrt(sum(v * v for v in vector)) - 1) > 0.001:
                raise RuntimeError('invalid-vector')
            results.append({'inputId': item['inputId'], 'vector': vector})
    return {'spaceId': request['spaceId'], 'results': results}


if __name__ == '__main__':
    # Reserve original stdout for JSON; native diagnostics must never corrupt the protocol.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8')
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    try:
        result = run(sys.argv[1:])
    except MemoryError:
        result = {'error': 'resource-limit'}
    except OSError:
        result = {'error': 'unsupported'}
    except ValueError:
        result = {'error': 'invalid-input'}
    except Exception:
        result = {'error': 'runtime-crash'}
    protocol.write(json.dumps(result, ensure_ascii=True, allow_nan=False) + '\n')
    protocol.flush()
