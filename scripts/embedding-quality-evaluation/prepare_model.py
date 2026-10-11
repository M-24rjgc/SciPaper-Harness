"""Download only the frozen public text-model asset; reject mismatched bytes."""
import argparse, hashlib, json, urllib.request
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--manifest',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
spec=json.loads(args.manifest.read_text())['models']['text']
args.output.mkdir(parents=True,exist_ok=True)
target=args.output/spec['name']; partial=target.with_suffix('.part')
digest=hashlib.sha256(); count=0
try:
    with urllib.request.urlopen(spec['url'],timeout=120) as response, partial.open('xb') as output:
        while chunk:=response.read(1024*1024):
            count+=len(chunk)
            if count>spec['bytes']:raise ValueError('model-exceeds-pinned-size')
            digest.update(chunk);output.write(chunk)
    if count!=spec['bytes'] or digest.hexdigest()!=spec['sha256']:raise ValueError('model-integrity-failed')
    partial.replace(target)
finally:
    partial.unlink(missing_ok=True)
print(json.dumps({'name':spec['name'],'bytes':count,'sha256':digest.hexdigest()}))
