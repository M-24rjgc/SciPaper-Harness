"""Synthetic, local-only native runtime checks. These are not quality benchmarks."""
from pathlib import Path
import time,json,math,platform,importlib.metadata,os,hashlib,struct,zlib,wave,io
from urllib.request import urlopen
try:
 import resource
except ImportError:
 resource = None
from litert_lm import Backend,EmbeddingEngine,EmbeddingOptions,InputOverflowStrategy,Content
root=Path(os.environ.get('EMBEDDING_PROBE_DIR', str(Path(__file__).parent / '.embedding-probe')));root.mkdir(parents=True,exist_ok=True)
ASSETS=[
 ('text','embeddinggemma-2-text-270m-litert-lm','9be6e8b90982095dc05c2bd162e4b954ee4dbac7','embeddinggemma-2-text-270m.litertlm',164626432,'2d079ee2f6f066b1f368e8d7c819f55214eaef1d0513b312321901f30ab286fb'),
 ('vision','embeddinggemma-2-text-vision-440m-litert-lm','e301f74d5551b0c2641bd5cb4652a76239d5c5f8','embeddinggemma-2-text-vision-440m.litertlm',387710976,'92dcbea108899e5d6e30d919b0744f90d9967e80c67a4ab5503ac16d54f62eb0'),
 ('full','embeddinggemma-2-740m-litert-lm','24d962e906c7d332c6428e71c9676855024569e2','embeddinggemma-2-740m.litertlm',484622336,'e7a8a2204b91e0f96e92960e84a09a89212e1633dcb7575a9bf3378b4df77f4c'),
]
def download(asset):
 kind,repo,revision,name,size,sha=asset;model=root/name
 if not model.exists():
  partial=model.with_suffix('.part');total=0
  with urlopen(f'https://huggingface.co/litert-community/{repo}/resolve/{revision}/{name}',timeout=120) as response,partial.open('wb') as f:
   while chunk:=response.read(1024*1024):
    total+=len(chunk)
    if total>size:raise RuntimeError('asset exceeds expected bound')
    f.write(chunk)
  with partial.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==sha
  assert total==size;partial.replace(model)
 with model.open('rb') as f:assert hashlib.file_digest(f,'sha256').hexdigest()==sha
 assert model.stat().st_size==size
 print(json.dumps({'event':'asset_verified','kind':kind,'bytes':size,'sha256':sha}),flush=True)
 return model

def png(color,circle):
 width=height=224;data=bytearray()
 for y in range(height):
  data.append(0)
  for x in range(width):
   inside=((x-112)**2+(y-112)**2<75**2) if circle else (40<x<184 and 40<y<184)
   data.extend(color if inside else (255,255,255))
 def chunk(name,payload):return struct.pack('>I',len(payload))+name+payload+struct.pack('>I',zlib.crc32(name+payload)&0xffffffff)
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(data)))+chunk(b'IEND',b'')

def tone():
 b=io.BytesIO()
 with wave.open(b,'wb') as f:
  f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000)
  f.writeframes(b''.join(struct.pack('<h',int(5000*math.sin(2*math.pi*440*i/16000))) for i in range(16000)))
 return b.getvalue()

def validate(v):
 assert len(v)==768 and all(math.isfinite(x) for x in v)
 norm=math.sqrt(sum(x*x for x in v));assert abs(norm-1)<1e-4
 return norm

samples=[('doc_emotion','task: search result | text: Speech emotion recognition classifies emotional states from acoustic signals.'),('doc_graph','task: search result | text: A graph neural network aggregates messages from neighboring nodes.'),('doc_food','task: search result | text: A recipe for baking chocolate cookies with butter and sugar.'),('query_en','task: search query | text: How can we detect emotions in spoken audio?'),('query_zh','task: search query | text: 如何从语音信号识别说话人的情绪？')]
results=[]
for asset in ASSETS:
 kind=asset[0];model=download(asset);cache=root/f'cache-{kind}';cache.mkdir(exist_ok=True)
 t0=time.perf_counter();rows=[];vectors={}
 opts=EmbeddingOptions(normalize=True,input_overflow_strategy=InputOverflowStrategy.ERROR)
 extra={} if kind=='text' else {'vision_backend':Backend.CPU(thread_count=2)}
 if kind=='full':extra['audio_backend']=Backend.CPU(thread_count=2)
 with EmbeddingEngine(str(model),backend=Backend.CPU(thread_count=2),cache_dir=str(cache),**extra) as engine:
  loaded=time.perf_counter()-t0
  def compute(key,contents):
   t=time.perf_counter();v=engine.compute_embedding(contents,options=opts).embedding
   rows.append({'id':key,'seconds':time.perf_counter()-t,'dimensions':len(v),'norm':validate(v)});vectors[key]=v
  for key,value in samples:compute(key,value)
  scores={q:{d:sum(a*b for a,b in zip(vectors[q],vectors[d])) for d in ('doc_emotion','doc_graph','doc_food')} for q in ('query_en','query_zh')}
  for q,s in scores.items():assert max(s,key=s.get)=='doc_emotion',s
  short=engine.compute_embedding(samples[-1][1],options=EmbeddingOptions(normalize=True,output_size=256,input_overflow_strategy=InputOverflowStrategy.ERROR)).embedding
  assert len(short)==256 and abs(math.sqrt(sum(x*x for x in short))-1)<1e-4
  if kind!='text':
   red=Content.ImageBytes(png((220,30,30),True));blue=Content.ImageBytes(png((30,30,220),False))
   compute('red_circle',red);compute('blue_square',blue)
   compute('query_red','task: search query | text: A red circle on a white background.')
   compute('query_blue','task: search query | text: A blue square on a white background.')
   compute('two_frames',[red,blue])
   assert vectors['red_circle']!=vectors['blue_square']
   scores['synthetic_image_plumbing']={q:{d:sum(a*b for a,b in zip(vectors[q],vectors[d])) for d in ('red_circle','blue_square')} for q in ('query_red','query_blue')}
  if kind=='full':compute('audio_tone',Content.AudioBytes(tone()))
 try:engine.compute_embedding('closed');raise AssertionError('closed engine accepted input')
 except RuntimeError as e:assert 'closed' in str(e)
 result={'kind':'synthetic-plumbing-smoke-not-quality-evaluation','variant':kind,'platform':platform.platform(),'python':platform.python_version(),'runtime':importlib.metadata.version('litert-lm-api'),'backend':'cpu','threads':2,'loadSeconds':loaded,'rows':rows,'scores':scores,'truncatedDimensions':len(short),'closedEngineRejects':True,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss if resource is not None else None,'modelSha256':asset[-1]}
 results.append(result);(root/'text-smoke-result.json').write_text(json.dumps(results,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False),flush=True)
