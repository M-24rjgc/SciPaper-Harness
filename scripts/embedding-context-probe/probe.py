"""Hash-locked text and vision only; run exact shipped worker under its unchanged OS cap."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import urllib.request

here = Path(__file__).resolve().parent
root = Path(os.environ['EMBEDDING_PROBE_DIR'])
root.mkdir(parents=True, exist_ok=True)
manifest = json.loads((here / 'runtime/assets.json').read_text())
worker = here / 'runtime/worker.py'
expected_worker = 'cbed91ab55b07526d9142c81cc0274991b872f19967769a62f3da048b0639d01'
assert hashlib.sha256(worker.read_bytes()).hexdigest() == expected_worker

def verified(asset):
    target = root / asset['name']
    with urllib.request.urlopen(asset['url'], timeout=120) as response, target.open('wb') as output:
        count = 0
        while block := response.read(1024 * 1024):
            count += len(block)
            assert count <= asset['bytes']
            output.write(block)
    assert count == asset['bytes']
    with target.open('rb') as source:
        assert hashlib.file_digest(source, 'sha256').hexdigest() == asset['sha256']
    return target

key = 'win32-x64' if sys.platform == 'win32' else 'linux-x64'
wheel = verified(manifest['wheels'][key])
runtime = root / 'runtime'
runtime.mkdir()
install = subprocess.run([sys.executable, '-I', str(here / 'runtime/install.py'), str(wheel), str(runtime), '536870912'], capture_output=True, text=True, check=True)
assert json.loads(install.stdout) == {'installed': True}
rows = []
for variant in ('text', 'vision'):
    model = verified(manifest['models'][variant])
    result = subprocess.run([sys.executable, '-I', str(here / 'tests/native-smoke.py'), '--runtime', str(runtime), '--model', str(model), '--variant', variant, '--cache', str(root / ('cache-' + variant)), '--memory-bytes', '8589934592'], capture_output=True, text=True, timeout=420)
    assert result.returncode == 0, (variant, result.returncode, result.stdout[-4096:], result.stderr[-4096:])
    row = json.loads(result.stdout)
    rows.append(row)
    print(json.dumps(row), flush=True)
(root / 'context-result.json').write_text(json.dumps({'workerSha256': expected_worker, 'platform': platform.platform(), 'maxInputTokens': 8192, 'results': rows}, indent=2))
