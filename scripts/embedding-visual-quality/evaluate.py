"""SPIQA test-C human-evidence within-paper figure retrieval, fixed before inference."""
import argparse,base64,hashlib,io,json,math,os,platform,resource,stat,statistics,subprocess,sys,time,zipfile
from pathlib import Path,PurePosixPath
from common import sha,load,save,get_asset,metrics,rank
HERE=Path(__file__).resolve().parent

def archive(data):
    z=zipfile.ZipFile(io.BytesIO(data));members=z.infolist()
    if len(members)>10000 or len({m.filename for m in members})!=len(members):raise ValueError('zip-count-or-duplicates')
    if sum(m.file_size for m in members)>536870912:raise ValueError('zip-expansion-budget')
    for m in members:
        path=PurePosixPath(m.filename)
        if path.is_absolute() or '..' in path.parts or '\\' in m.filename or len(m.filename.encode())>1024:raise ValueError('zip-path')
        if stat.S_ISLNK(m.external_attr>>16) or m.flag_bits&1 or m.file_size>33554432:raise ValueError('zip-unsafe-member')
    return z

def prepare(args,cfg):
    manifest=load(HERE/'assets.json');external=args.work/'external';external.mkdir(parents=True,exist_ok=True)
    raw={name:get_asset(spec,external/name) for name,spec in manifest['assets'].items()}
    data=json.loads(raw['metadata']);frozen=load(HERE/'frozen-selection.json');queries=[]
    for paper,row in data.items():
        assert len(row['question'])==len(row['referred_figures_tables'])==len(row['question_key'])
        for i,q in enumerate(row['question']):queries.append({'id':paper+':'+str(i),'paperId':paper,'index':i,'questionKey':row['question_key'][i]})
    queries.sort(key=lambda q:sha((cfg['seed']+':'+q['id']).encode()));queries=queries[:cfg['queries']]
    assert queries==frozen['selectedQueries'],'frozen queries changed'
    assert sorted({q['paperId'] for q in queries})==frozen['paperIds']
    expected={image['id']:image for image in frozen['images']};documents=[];image_inputs=[]
    with archive(raw['images']) as z:
        for paper in frozen['paperIds']:
            for figure in data[paper]['figures_and_tables']:
                id=paper+'/'+figure['file'];spec=expected[id];b=z.read(spec['member'])
                assert len(b)==spec['bytes'] and sha(b)==spec['sha256'] and len(b)<=cfg['maxImageBytes']
                documents.append({'id':id,'paperId':paper,'title':'','text':figure['caption']})
                image_inputs.append({'inputId':id,'kind':'image','mediaType':'image/png','data':base64.b64encode(b).decode()})
    assert [d['id'] for d in documents]==list(expected),'image ordering changed'
    texts=[]
    for q in queries:
        row=data[q['paperId']];text=row['question'][q['index']]
        assert text.strip() and len(text.encode())<=cfg['maxTextBytes']
        assert [q['paperId']+'/'+name for name in row['referred_figures_tables'][q['index']]]==frozen['labels'][q['id']]
        texts.append({'inputId':q['id'],'kind':'text','text':text})
        q['text']=text
    save(args.output/'selection.json',frozen)
    return documents,queries,image_inputs,texts,frozen

def embed(args,cfg,inputs,purpose,identity,deadline):
    vectors=[];timings=[]
    for start in range(0,len(inputs),cfg['batchSize']):
        batch=inputs[start:start+cfg['batchSize']];request={'spaceId':identity,'purpose':purpose,'inputs':batch}
        wire=json.dumps(request);assert len(wire.encode())<=cfg['maxRequestBytes']
        cache=args.work/'vectors'/(sha(wire.encode())+'.json');seconds=None
        if cache.exists():response=load(cache)
        else:
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('total-evaluation-timeout')
            command=[sys.executable,'-I',str(args.product_root/'packages/llm/embedding-litert-lm/runtime/worker.py'),str(args.runtime),str(args.model),str(args.work/'native-cache'),'vision',
                str(cfg['threads']),str(cfg['maxRequestBytes']),str(cfg['maxTextBytes']),str(cfg['maxImageBytes']),str(cfg['batchSize']),str(cfg['maxImagePixels']),str(cfg['memoryBytes']),str(cfg['maxInputTokens'])]
            begin=time.perf_counter();result=subprocess.run(command,input=wire,text=True,capture_output=True,timeout=min(remaining,cfg['batchTimeoutSeconds']));seconds=time.perf_counter()-begin
            if result.returncode:raise RuntimeError('worker-exit-'+str(result.returncode))
            response=json.loads(result.stdout)
            if 'error' in response:
                save(args.output/'failure.json',{'purpose':purpose,'batchStart':start,'inputIds':[d['inputId'] for d in batch],'category':response['error']})
                raise RuntimeError('worker-'+response['error'])
        assert response['spaceId']==identity and [r['inputId'] for r in response['results']]==[d['inputId'] for d in batch]
        rows=[r['vector'] for r in response['results']]
        for v in rows:assert len(v)==768 and all(math.isfinite(x) for x in v) and abs(math.sqrt(sum(x*x for x in v))-1)<.001
        if not cache.exists():save(cache,response)
        vectors.extend(rows);timings.append({'batchStart':start,'items':len(batch),'seconds':seconds,'cacheHit':seconds is None})
        print(json.dumps({'phase':purpose,'completed':len(vectors),'total':len(inputs),'seconds':seconds}),flush=True)
    return vectors,timings

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--product-root',type=Path,required=True);parser.add_argument('--runtime',type=Path);parser.add_argument('--model',type=Path)
    parser.add_argument('--work',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--lexical-only',action='store_true');args=parser.parse_args()
    for n in ['product_root','work','output','runtime','model']:
        if getattr(args,n):setattr(args,n,getattr(args,n).resolve())
    args.work.mkdir(parents=True,exist_ok=True);args.output.mkdir(parents=True,exist_ok=True)
    cfg=load(HERE/'config.json');contracts=load(HERE/'product-contracts.json');started=time.monotonic();deadline=started+cfg['totalTimeoutSeconds']
    for name,digest in contracts.items():assert sha((args.product_root/name).read_bytes())==digest
    docs,queries,image_inputs,text_inputs,selection=prepare(args,cfg)
    identity='spiqa-'+sha(json.dumps({'cfg':cfg,'assets':load(HERE/'assets.json'),'contracts':contracts},sort_keys=True).encode())
    methods=['lexical'] if args.lexical_only else ['lexical','semantic','hybrid'];ranks=[];per_query={m:[] for m in methods};timings={};vectors=query_vectors=None
    if not args.lexical_only:
        assert args.runtime and args.model
        assets=load(args.product_root/'packages/llm/embedding-litert-lm/runtime/assets.json');spec=assets['models']['vision']
        assert args.model.stat().st_size==spec['bytes'] and sha(args.model.read_bytes())==spec['sha256']
        save(args.output/'runtime-files.json',{str(p.relative_to(args.runtime)):sha(p.read_bytes()) for p in sorted(args.runtime.rglob('*')) if p.is_file() and '__pycache__' not in str(p)})
        (args.work/'native-cache').mkdir(exist_ok=True)
        vectors,timings['imageBatches']=embed(args,cfg,image_inputs,'document',identity,deadline)
        query_vectors,timings['queryBatches']=embed(args,cfg,text_inputs,'query',identity,deadline)
    for qi,q in enumerate(queries):
        indices=[i for i,d in enumerate(docs) if d['paperId']==q['paperId']]
        subset=[docs[i] for i in indices]
        row=rank(args.product_root,subset,[q],None if vectors is None else [vectors[i] for i in indices],None if query_vectors is None else [query_vectors[qi]])[0]
        relevant=set(selection['labels'][q['id']]);assert relevant and relevant<={d['id'] for d in subset}
        ranks.append(row)
        for method in methods:per_query[method].append({'queryId':q['id'],'candidateCount':len(subset),**metrics(row[method],relevant,cfg['cutoffs'])})
    aggregate={m:{key:statistics.mean(r[key] for r in rows) for key in rows[0] if key not in ['queryId','candidateCount']} for m,rows in per_query.items()}
    result={'status':'lexical-only' if args.lexical_only else 'complete','identity':identity,'config':cfg,'metrics':aggregate,'perQuery':per_query,'timings':timings,
        'elapsedSeconds':time.monotonic()-started,'queries':len(queries),'papers':len(selection['paperIds']),'images':len(docs),'assets':load(HERE/'assets.json'),'productContracts':contracts,
        'hardware':{'platform':platform.platform(),'cpuCount':os.cpu_count(),'python':sys.version,'peakChildRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
            'cpuInfo':Path('/proc/cpuinfo').read_text() if Path('/proc/cpuinfo').exists() else None,'memoryInfo':Path('/proc/meminfo').read_text() if Path('/proc/meminfo').exists() else None},
        'limitations':['Within-paper scientific figure/table evidence retrieval; not page localization, global literature search, answer correctness or claim verification.',
            '32 fixed public test-C questions from QASPER, with creator-reported manual evidence-figure checking; no new labels or generated query rewrites.',
            'All figures/tables from selected papers are candidates; referenced figures are binary relevant, other potentially valid evidence is not exhaustively judged.',
            'Paper and query selection fixed before embedding. No tuning or minimum-quality threshold. Model training overlap unknown.',
            'Original PNGs and actual product vision worker; captions used only in lexical baseline/fusion, not as vision input.',
            'Metrics macro-averaged over queries; small candidate pools often make high-k recall easy; per-query candidate counts retained.',
            'Latency includes process/model reload; peak child RSS includes Node ranker and is not target-device steady-state resource use.']}
    save(args.output/'results.json',result);save(args.output/'rankings.json',ranks)
    print(json.dumps({'status':result['status'],'metrics':aggregate,'queries':len(queries),'papers':len(selection['paperIds']),'images':len(docs)},indent=2))
if __name__=='__main__':main()
