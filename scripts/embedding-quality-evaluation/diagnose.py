"""Isolate the observed ninth-batch failure without changing data or product worker."""
import argparse, hashlib, importlib.util, io, json, os, re, resource, subprocess, sys, tempfile, time
from pathlib import Path

if len(sys.argv)>1 and sys.argv[1]=='--child':
    _,_,worker_path,runtime,model,cache,report_path=sys.argv
    spec=importlib.util.spec_from_file_location('product_worker',worker_path)
    worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
    worker.limit_memory(8589934592)
    sys.path.insert(0,runtime)
    import litert_lm
    original=litert_lm.EmbeddingEngine
    raw=sys.stdin.buffer.read();request=json.loads(raw);count=0;diagnostics=[]
    class TracedEngine:
        def __init__(self,*args,**kwargs):self.engine=original(*args,**kwargs)
        def __enter__(self):self.engine.__enter__();return self
        def __exit__(self,*args):return self.engine.__exit__(*args)
        def compute_embedding(self,*args,**kwargs):
            global count
            item=request['inputs'][count]; count+=1
            try:
                result=self.engine.compute_embedding(*args,**kwargs)
                diagnostics.append({'inputId':item['inputId'],'bytes':len(item['text'].encode()),'status':'ok'})
                return result
            except Exception as exc:
                text=str(exc).lower()
                diagnostics.append({'inputId':item['inputId'],'bytes':len(item['text'].encode()),'status':'error',
                    'exceptionType':type(exc).__name__,'exceptionSha256':hashlib.sha256(str(exc).encode()).hexdigest(),
                    'recognizedTerms':[w for w in ['token','overflow','exceed','limit','too long','length','memory','allocation','xnnpack','unsupported','2048'] if w in text],
                    'numericFields':re.findall(r'\b\d{1,10}\b',text)[:30]})
                raise
    litert_lm.EmbeddingEngine=TracedEngine
    sys.stdin=io.TextIOWrapper(io.BytesIO(raw),encoding='utf-8')
    # Native messages may include input; keep raw bytes only in an anonymous temporary file.
    with tempfile.TemporaryFile(mode='w+b') as private_log:
        os.dup2(private_log.fileno(),1);os.dup2(private_log.fileno(),2)
        try:
            worker.run([runtime,model,cache,'text','2','16777216','8192','8388608','32','16777216','8589934592','8192'])
            status='complete'
        except Exception as exc:status=type(exc).__name__
        private_log.flush();private_log.seek(0);native=private_log.read(1048576)
    native_text=native.decode('utf-8',errors='replace').lower()
    safe_native={'bytes':len(native),'sha256':hashlib.sha256(native).hexdigest(),
        'recognizedTerms':[w for w in ['token','overflow','exceed','limit','too long','length','memory','allocation','xnnpack','unsupported','2048','invalid_argument','resource_exhausted','max_input','context','capacity'] if w in native_text],
        'numericErrorFields':[re.findall(r'\b\d{1,10}\b',line)[-15:] for line in native_text.splitlines() if any(w in line for w in ['exceed','too long','overflow','max_input','resource_exhausted'])][-10:]}
    Path(report_path).write_text(json.dumps({'status':status,'diagnostics':diagnostics,'native':safe_native,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss},indent=2)+'\n')
    sys.exit(0)

from evaluate import load, prepare, sha
parser=argparse.ArgumentParser()
parser.add_argument('--product-root',type=Path,required=True);parser.add_argument('--runtime',type=Path,required=True)
parser.add_argument('--model',type=Path,required=True);parser.add_argument('--work',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
for name in ['product_root','runtime','model','work','output']:setattr(args,name,getattr(args,name).resolve())
args.work.mkdir(parents=True,exist_ok=True);args.output.mkdir(parents=True,exist_ok=True)
root=Path(__file__).resolve().parent;cfg=load(root/'config.json')
for name,digest in load(root/'product-contracts.json').items():assert sha((args.product_root/name).read_bytes())==digest
assets=load(args.product_root/'packages/llm/embedding-litert-lm/runtime/assets.json');assert sha(args.model.read_bytes())==assets['models']['text']['sha256']
docs,queries,labels,selection=prepare(args,cfg,load(root/'dataset-assets.json'))
batch=docs[256:288];request={'spaceId':'frozen-failure-diagnostic','purpose':'document','inputs':[{'inputId':d['id'],'kind':'text','text':d['text']} for d in batch]}
cache=args.work/'diagnostic-cache';cache.mkdir(exist_ok=True)
report=args.output/'native-failure-diagnostic.json'
result=subprocess.run([sys.executable,'-I',str(root/'diagnose.py'),'--child',str(args.product_root/'packages/llm/embedding-litert-lm/runtime/worker.py'),str(args.runtime),str(args.model),str(cache),str(report)],input=json.dumps(request),text=True,capture_output=True,timeout=300)
if result.returncode:raise RuntimeError('diagnostic-process-exit-'+str(result.returncode))
print(report.read_text())
