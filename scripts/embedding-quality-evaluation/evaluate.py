"""Bounded real scientific retrieval evaluation. No paid APIs or private inputs."""
import argparse, hashlib, io, json, math, os, platform, resource, statistics
import subprocess, sys, tarfile, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent

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

def prepare(args, cfg, manifest):
    external = args.work/'external'; external.mkdir(parents=True, exist_ok=True)
    get_asset(manifest['license'], external/'LICENSE.md')
    data = get_asset(manifest['data'], external/'data.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        raw = {name:archive.extractfile('data/'+name+'.jsonl').read() for name in ['corpus','claims_dev']}
    # Read exact members only; never extract untrusted archive paths.
    for name, spec in manifest['members'].items():
        assert sha(raw[name]) == spec['sha256'] and len(raw[name]) == spec['bytes']
    corpus = [json.loads(line) for line in raw['corpus'].splitlines()]
    claims = [json.loads(line) for line in raw['claims_dev'].splitlines()]
    seed = cfg['seed']; order = lambda id:sha((seed+':'+str(id)).encode())
    eligible = [q for q in claims if q['evidence']]
    selected = sorted(eligible,key=lambda q:order(q['id']))[:cfg['queries']]
    queries = [{'id':str(q['id']),'text':q['claim']} for q in selected]
    labels = {str(q['id']):set(map(str,q['evidence'])) for q in selected}
    docs = [{'id':str(d['doc_id']),'title':d['title'],'text':' '.join(d['abstract'])} for d in corpus]
    docs.sort(key=lambda d:d['id'])
    gold = set().union(*labels.values())
    assert gold <= {d['id'] for d in docs}
    full_rank = rank(args.product_root, docs, queries)
    chosen = set(gold)
    for row in full_rank: chosen.update(row['lexical'][:cfg['hardNegativesPerQuery']])
    hard_count = len(chosen)-len(gold)
    assert len(chosen) <= cfg['documents']
    for d in sorted(docs,key=lambda d:order(d['id'])):
        if len(chosen) >= cfg['documents']: break
        chosen.add(d['id'])
    docs = [d for d in docs if d['id'] in chosen]
    # Preflight only, never quietly drop long documents or positive labels.
    assert all(0 < len(d['text'].encode()) <= cfg['maxTextBytes'] for d in docs)
    provenance = dict(fullCorpus=len(corpus),publicDevClaims=len(claims),eligibleEvidenceClaims=len(eligible),
        evaluatedQueries=len(queries),candidateDocuments=len(docs),goldDocuments=len(gold),hardDistractorDocuments=hard_count,
        queryIds=[q['id'] for q in queries],documentIds=[d['id'] for d in docs],
        labels={k:sorted(v) for k,v in labels.items()},maxDocumentBytes=max(len(d['text'].encode()) for d in docs))
    assert provenance == load(HERE/'frozen-selection.json'), 'Frozen selection changed'
    save(args.output/'selection.json', provenance)
    return docs,queries,labels,provenance

def embed(args,cfg,items,purpose,identity,deadline):
    all_vectors=[]; timings=[]
    worker=args.product_root/'packages/llm/embedding-litert-lm/runtime/worker.py'
    for start in range(0,len(items),cfg['batchSize']):
        batch=items[start:start+cfg['batchSize']]
        request={'spaceId':'scipaper-quality-'+identity,'purpose':purpose,
                 'inputs':[{'inputId':d['id'],'kind':'text','text':d['text']} for d in batch]}
        key=sha(json.dumps(request,sort_keys=True).encode()); cached=args.work/'vectors'/f'{key}.json'
        if cached.exists(): response=load(cached); seconds=None
        else:
            remaining=deadline-time.monotonic()
            if remaining <= 0: raise TimeoutError('total-evaluation-timeout')
            command=[sys.executable,'-I',str(worker),str(args.runtime),str(args.model),str(args.work/'native-cache'),'text',
                     str(cfg['threads']),'16777216',str(cfg['maxTextBytes']),'8388608',str(cfg['batchSize']),'16777216',str(cfg['memoryBytes']),str(cfg['maxInputTokens'])]
            before=time.perf_counter()
            result=subprocess.run(command,input=json.dumps(request),capture_output=True,text=True,
                                  timeout=min(cfg['batchTimeoutSeconds'],remaining))
            seconds=time.perf_counter()-before
            if result.returncode: raise RuntimeError(f'worker-exit-{result.returncode}')
            response=json.loads(result.stdout)
            if 'error' in response: raise RuntimeError('worker-'+response['error'])
        assert response['spaceId']==request['spaceId']
        assert [r['inputId'] for r in response['results']]==[r['inputId'] for r in request['inputs']]
        vectors=[r['vector'] for r in response['results']]
        for vector in vectors:
            assert len(vector)==768 and all(math.isfinite(v) for v in vector)
            assert abs(math.sqrt(sum(v*v for v in vector))-1)<.001
        if not cached.exists(): save(cached,response)
        all_vectors.extend(vectors);timings.append({'start':start,'count':len(batch),'seconds':seconds,'cacheHit':seconds is None})
        print(json.dumps({'phase':purpose,'completed':len(all_vectors),'total':len(items),'seconds':seconds}),flush=True)
    return all_vectors,timings

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--product-root',type=Path,required=True)
    parser.add_argument('--runtime',type=Path);parser.add_argument('--model',type=Path)
    parser.add_argument('--work',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--lexical-only',action='store_true');args=parser.parse_args()
    args.product_root=args.product_root.resolve();args.work=args.work.resolve();args.output=args.output.resolve()
    args.work.mkdir(parents=True,exist_ok=True);args.output.mkdir(parents=True,exist_ok=True)
    cfg=load(HERE/'config.json'); manifest=load(HERE/'dataset-assets.json');contracts=load(HERE/'product-contracts.json')
    for name,expected in contracts.items():
        assert sha((args.product_root/name).read_bytes())==expected,'Product contract changed: '+name
    started=time.monotonic(); deadline=started+cfg['totalTimeoutSeconds']
    docs,queries,labels,selection=prepare(args,cfg,manifest)
    save(args.output/'lexical-baseline.json', {row['id']: metrics(row['lexical'], labels[row['id']], cfg['cutoffs']) for row in rank(args.product_root, docs, queries)})
    identity=sha(json.dumps({'cfg':cfg,'assets':manifest,'contracts':contracts},sort_keys=True).encode())
    timings={};vectors=query_vectors=None
    if not args.lexical_only:
        assert args.runtime and args.model,'Native runtime and model required'
        args.runtime=args.runtime.resolve();args.model=args.model.resolve()
        assets=load(args.product_root/'packages/llm/embedding-litert-lm/runtime/assets.json')
        assert args.model.stat().st_size==assets['models']['text']['bytes']
        assert sha(args.model.read_bytes())==assets['models']['text']['sha256']
        # Parent CI must hash-verify and extract the exact pinned wheel; record installed tree hash.
        runtime_files={str(p.relative_to(args.runtime)):sha(p.read_bytes()) for p in sorted(args.runtime.rglob('*')) if p.is_file() and '__pycache__' not in str(p)}
        save(args.output/'runtime-files.json',runtime_files)
        (args.work/'native-cache').mkdir(exist_ok=True)
        vectors,timings['documentBatches']=embed(args,cfg,docs,'document',identity,deadline)
        query_vectors,timings['queryBatches']=embed(args,cfg,queries,'query',identity,deadline)
    rank_started=time.perf_counter(); rankings=rank(args.product_root,docs,queries,vectors,query_vectors)
    timings['rankingSeconds']=time.perf_counter()-rank_started
    methods=['lexical'] if args.lexical_only else ['lexical','semantic','hybrid']
    per_query={m:[] for m in methods}
    for row in rankings:
        for method in methods:
            per_query[method].append({'queryId':row['id'],**metrics(row[method],labels[row['id']],cfg['cutoffs'])})
    aggregate={m:{key:statistics.mean(r[key] for r in rows) for key in rows[0] if key!='queryId'} for m,rows in per_query.items()}
    result={'status':'lexical-only' if args.lexical_only else 'complete','evaluationIdentity':identity,'config':cfg,
        'metrics':aggregate,'perQuery':per_query,'timings':timings,'elapsedSeconds':time.monotonic()-started,
        'dataset':manifest,'productContracts':contracts,'selection':selection,
        'hardware':{'platform':platform.platform(),'machine':platform.machine(),'cpuCount':os.cpu_count(),'python':sys.version,
            'cpuInfo':Path('/proc/cpuinfo').read_text() if Path('/proc/cpuinfo').exists() else None,
            'memoryInfo':Path('/proc/meminfo').read_text() if Path('/proc/meminfo').exists() else None,
            'peakChildRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss},
        'limitations':['32 public development claims held out from this run, not hidden test data; model training overlap unknown.',
            'Label-stratified 512-document candidate challenge includes all golds, lexical hard distractors and hash-sampled remainder; NOT full-corpus SciFact or BEIR metrics.',
            'Relevance means human support OR refutation evidence, not confirmation of a claim; unjudged treated nonrelevant.',
            'No training, parameter selection, threshold tuning, or scientific/visual superiority claims.',
            'Actual product worker/prefix/ranking, but abstract-as-one-chunk mapping; no PDF/page or end-to-end project index validation.',
            'Batch timing includes process/model reload; peak child RSS includes Node ranking; not target-device steady-state latency.']}
    save(args.output/'results.json',result)
    save(args.output/'rankings.json',rankings) # identifiers only, never corpus text or vectors
    print(json.dumps({'status':result['status'],'metrics':aggregate,'output':str(args.output)},indent=2))

if __name__=='__main__':
    main()
