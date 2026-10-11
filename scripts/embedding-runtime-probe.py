from pathlib import Path
import time,json,math,platform,importlib.metadata,os
from urllib.request import urlopen
import hashlib
try:
 import resource
except ImportError:
 resource = None
from litert_lm import Backend,EmbeddingEngine,EmbeddingOptions,InputOverflowStrategy
root=Path(os.environ.get('EMBEDDING_PROBE_DIR', str(Path(__file__).parent / '.embedding-probe')));root.mkdir(parents=True,exist_ok=True)
cache=root/'cache';cache.mkdir(exist_ok=True)
model=root/'embeddinggemma-2-text-270m.litertlm'
expected='2d079ee2f6f066b1f368e8d7c819f55214eaef1d0513b312321901f30ab286fb'
url='https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm/resolve/9be6e8b90982095dc05c2bd162e4b954ee4dbac7/embeddinggemma-2-text-270m.litertlm'
if not model.exists():
 partial=model.with_suffix('.part');total=0
 with urlopen(url,timeout=120) as response,partial.open('wb') as f:
  while chunk:=response.read(1024*1024):
   total+=len(chunk)
   if total>200_000_000:raise RuntimeError('asset exceeds expected bound')
   f.write(chunk)
 if hashlib.file_digest(partial.open('rb'),'sha256').hexdigest()!=expected:raise RuntimeError('model checksum mismatch')
 partial.replace(model)
with model.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==expected
assert model.stat().st_size==164626432
print(json.dumps({'event':'asset_verified','bytes':model.stat().st_size,'sha256':expected}),flush=True)
t0=time.perf_counter();rows=[]
with EmbeddingEngine(str(root/'embeddinggemma-2-text-270m.litertlm'), backend=Backend.CPU(thread_count=2),cache_dir=str(cache)) as engine:
 loaded=time.perf_counter()-t0
 options=EmbeddingOptions(normalize=True,input_overflow_strategy=InputOverflowStrategy.ERROR)
 samples=[('doc_emotion','task: search result | text: Speech emotion recognition classifies emotional states from acoustic signals.'),('doc_graph','task: search result | text: A graph neural network aggregates messages from neighboring nodes.'),('doc_food','task: search result | text: A recipe for baking chocolate cookies with butter and sugar.'),('query_en','task: search query | text: How can we detect emotions in spoken audio?'),('query_zh','task: search query | text: 如何从语音信号识别说话人的情绪？')]
 vectors={}
 for key,text in samples:
  t=time.perf_counter();v=engine.compute_embedding(text,options=options).embedding;elapsed=time.perf_counter()-t
  assert len(v)==768 and all(math.isfinite(x) for x in v)
  norm=math.sqrt(sum(x*x for x in v));assert abs(norm-1)<1e-4
  vectors[key]=v;rows.append({'id':key,'seconds':elapsed,'dimensions':len(v),'norm':norm})
 short=engine.compute_embedding(samples[-1][1],options=EmbeddingOptions(normalize=True,output_size=256,input_overflow_strategy=InputOverflowStrategy.ERROR)).embedding
 assert len(short)==256 and abs(math.sqrt(sum(x*x for x in short))-1)<1e-4
 scores={q:{d:sum(a*b for a,b in zip(vectors[q],vectors[d])) for d in ('doc_emotion','doc_graph','doc_food')} for q in ('query_en','query_zh')}
 for q,s in scores.items():assert max(s,key=s.get)=='doc_emotion',s
try:engine.compute_embedding('closed');raise AssertionError('closed engine accepted input')
except RuntimeError as e:assert 'closed' in str(e)
result={'kind':'synthetic-plumbing-smoke-not-quality-evaluation','platform':platform.platform(),'python':platform.python_version(),'runtime':importlib.metadata.version('litert-lm-api'),'backend':'cpu','threads':2,'loadSeconds':loaded,'rows':rows,'scores':scores,'truncatedDimensions':len(short),'closedEngineRejects':True,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource is not None else None,'modelSha256':expected}
(root/'text-smoke-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
