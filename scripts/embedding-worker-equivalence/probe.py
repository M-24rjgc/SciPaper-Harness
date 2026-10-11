"""Small public-input old/new worker invariance check; not a quality rerun."""
import base64,hashlib,io,json,math,os,platform,subprocess,sys,tarfile,time,urllib.request,zipfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=Path(os.environ['EMBEDDING_PROBE_DIR']).resolve();ROOT.mkdir(parents=True,exist_ok=True)
OUT=Path('embedding-equivalence-results');OUT.mkdir(exist_ok=True)
def sha(b):return hashlib.sha256(b).hexdigest()
def load(p):return json.loads(p.read_text())
def verified(spec,name):
    target=ROOT/name
    if not target.exists():
        digest=hashlib.sha256();count=0;partial=target.with_suffix('.part')
        with urllib.request.urlopen(spec['url'],timeout=120) as response,partial.open('wb') as output:
            while b:=response.read(1048576):
                count+=len(b)
                if count>spec['bytes']:raise ValueError('asset-size')
                digest.update(b);output.write(b)
        assert count==spec['bytes'] and digest.hexdigest()==spec['sha256'];partial.replace(target)
    assert target.stat().st_size==spec['bytes'] and sha(target.read_bytes())==spec['sha256']
    return target
config=load(HERE/'config.json');assets=load(HERE/'assets.json')
for name,digest in config['workerHashes'].items():assert sha((HERE/name).read_bytes())==digest
old=(HERE/'old-worker.py').read_text();new=(HERE/'new-worker.py').read_text()
change="                if item['mediaType'] not in ('image/png', 'image/jpeg', 'image/webp'):\n"
replacement="                if item['mediaType'] == 'image/webp':\n                    raise OSError('unsupported-image-media')\n                if item['mediaType'] not in ('image/png', 'image/jpeg'):\n"
assert old.count(change)==1 and old.replace(change,replacement)==new,'Source diff exceeds declared WebP-only change'
corpus_file=verified(assets['scifact'],'scifact-data.tar.gz')
with tarfile.open(corpus_file) as t:
    docs={str(r['doc_id']):r for r in (json.loads(b) for b in t.extractfile('data/corpus.jsonl').read().splitlines())}
    queries={str(r['id']):r for r in (json.loads(b) for b in t.extractfile('data/claims_dev.jsonl').read().splitlines())}
visual_meta=load(verified(assets['spiqaMetadata'],'spiqa-metadata.json'))
zip_path=verified(assets['spiqaImages'],'spiqa-images.zip')
text_documents=[{'inputId':id,'kind':'text','text':' '.join(docs[id]['abstract'])} for id in config['textDocumentIds']]
text_queries=[{'inputId':id,'kind':'text','text':queries[id]['claim']} for id in config['textQueryIds']]
images=[]
with zipfile.ZipFile(zip_path) as z:
    for image in config['visualImages']:
        # Exact frozen members only; never extract archive paths.
        b=z.read(image['member']);assert len(b)==image['bytes'] and sha(b)==image['sha256']
        images.append({'inputId':image['id'],'kind':'image','mediaType':'image/png','data':base64.b64encode(b).decode()})
visual_queries=[{'inputId':q['id'],'kind':'text','text':visual_meta[q['paperId']]['question'][q['index']]} for q in config['visualQueries']]
models={v:verified(assets['models'][v],assets['models'][v]['name']) for v in ['text','vision']}
runtime=Path(os.environ['EMBEDDING_RUNTIME']).resolve()
results=[]
for variant,purpose,inputs in [('text','document',text_documents),('text','query',text_queries),('vision','document',images),('vision','query',visual_queries)]:
    request={'spaceId':'public-equivalence-8192','purpose':purpose,'inputs':inputs};vectors=[];timings=[]
    for name in ['old-worker.py','new-worker.py']:
        cache=ROOT/(variant+'-'+name);cache.mkdir(exist_ok=True)
        command=[sys.executable,'-I',str(HERE/name),str(runtime),str(models[variant]),str(cache),variant,'2','16777216','8192','8388608','8','16777216','8589934592','8192']
        start=time.perf_counter();r=subprocess.run(command,input=json.dumps(request),capture_output=True,text=True,timeout=300);timings.append(time.perf_counter()-start)
        assert r.returncode==0,'worker-exit-'+str(r.returncode)
        output=json.loads(r.stdout);assert 'error' not in output,output.get('error')
        assert output['spaceId']==request['spaceId'] and [x['inputId'] for x in output['results']]==[x['inputId'] for x in inputs]
        rows=[x['vector'] for x in output['results']]
        for vector in rows:assert len(vector)==768 and all(math.isfinite(v) for v in vector) and abs(math.sqrt(sum(v*v for v in vector))-1)<.001
        vectors.append(rows)
    for item,a,b in zip(inputs,*vectors):
        delta=max(abs(x-y) for x,y in zip(a,b));cosine=sum(x*y for x,y in zip(a,b))/math.sqrt(sum(x*x for x in a)*sum(y*y for y in b))
        assert delta<=config['maxAbsoluteDelta'] and cosine>=config['minimumCosine'],'sample-invariance-failed'
        results.append({'variant':variant,'purpose':purpose,'inputId':item['inputId'],'maxAbsoluteDelta':delta,'cosine':cosine,'identicalFullVector':a==b,'oldNewBatchSeconds':timings})
report={'status':'complete','commit':os.environ['GITHUB_SHA'],'config':config,'results':results,'reviewedSourceDelta':'Only image/webp handling changes from native decode attempt to explicit unsupported; text/PNG/JPEG/context branches otherwise byte-identical.',
    'limitations':['Eight frozen public inputs only; sample invariance is not universal numerical equivalence.',
    'Original quality metrics retain their original run/commit provenance; this does not rerun or independently validate those rankings.',
    'No vectors, source text or images are emitted. Same CPU runtime, model bytes and8192 context for paired runs.'],
    'hardware':{'platform':platform.platform(),'cpuCount':os.cpu_count(),'python':sys.version}}
(OUT/'equivalence.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
