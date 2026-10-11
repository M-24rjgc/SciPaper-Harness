import hashlib,json,math,subprocess,urllib.request
from pathlib import Path
HERE=Path(__file__).resolve().parent

def sha(value): return hashlib.sha256(value).hexdigest()

def load(path): return json.loads(Path(path).read_text())

def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n'); temp.replace(path)

def get_asset(spec, target):
    if not target.exists():
        with urllib.request.urlopen(spec['url'], timeout=60) as r:
            data = r.read(spec['bytes'] + 1)
        if len(data) != spec['bytes'] or sha(data) != spec['sha256']: raise ValueError('asset-integrity')
        target.write_bytes(data)
    data = target.read_bytes()
    if len(data) != spec['bytes'] or sha(data) != spec['sha256']: raise ValueError('asset-integrity')
    return data

def metrics(ranking, relevant, cutoffs):
    if not relevant or len(ranking) != len(set(ranking)): raise ValueError('invalid-ranking-or-labels')
    result = {'MRR': next((1 / (i+1) for i,d in enumerate(ranking) if d in relevant), 0)}
    for k in cutoffs:
        hits = [int(d in relevant) for d in ranking[:k]]
        result[f'Recall@{k}'] = sum(hits) / len(relevant)
        ideal = sum(1/math.log2(i+2) for i in range(min(k, len(relevant))))
        result[f'nDCG@{k}'] = sum(v/math.log2(i+2) for i,v in enumerate(hits)) / ideal
        result[f'MRR@{k}'] = next((1/(i+1) for i,v in enumerate(hits) if v), 0)
    return result

def rank(product, documents, queries, vectors=None, query_vectors=None):
    payload = dict(documents=documents, queries=queries, vectors=vectors, queryVectors=query_vectors)
    result = subprocess.run(['node', str(HERE/'rank.mjs'), str(product/'packages/research/workbench/src/clustering.ts')],
        input=json.dumps(payload), capture_output=True, text=True, timeout=120)
    if result.returncode: raise RuntimeError('product-ranker-failed: '+result.stderr[-1000:])
    return json.loads(result.stdout)
