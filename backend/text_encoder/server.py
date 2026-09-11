"""Pinned local BGE-M3 dense encoder. User text never leaves loopback or enters logs."""
import hashlib,json,threading,os
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import torch
from transformers import AutoModel,AutoTokenizer
from setup import REVISION,WEIGHTS  # setup constants are imported below without network
ROOT=Path(__file__).parent/'models'/'bge-m3'
MODEL_ID='bge-m3-dense-v1'
with (ROOT/'pytorch_model.bin').open('rb') as f:
    if hashlib.file_digest(f,'sha256').hexdigest()!=WEIGHTS: raise RuntimeError('text_model_checksum_mismatch')
torch.set_num_threads(2)
TOKENIZER=AutoTokenizer.from_pretrained(ROOT,local_files_only=True,trust_remote_code=False)
# The pinned upstream revision publishes a PyTorch state dict; Torch loads it
# with its restricted weights-only loader. No alternate weights/model path.
MODEL=AutoModel.from_pretrained(ROOT,local_files_only=True,trust_remote_code=False,use_safetensors=False,add_pooling_layer=False).eval()
SLOTS=threading.BoundedSemaphore(1)
PROVENANCE={'model_id':MODEL_ID,'revision':REVISION,'weights_sha256':WEIGHTS,'dimension':1024,'pooling':'cls-l2','precision':'float32','max_tokens':512,'query_instruction':'none','local':True}
def embed(texts):
    if not isinstance(texts,list) or not 1<=len(texts)<=4 or any(not isinstance(t,str) or not t or len(t.encode())>4096 for t in texts): raise ValueError('invalid_text_batch')
    x=TOKENIZER(texts,padding=True,truncation=False,return_tensors='pt')
    if x['input_ids'].shape[1]>512: raise ValueError('text_token_budget_exceeded')
    with torch.inference_mode():
        vectors=torch.nn.functional.normalize(MODEL(**x).last_hidden_state[:,0],p=2,dim=1)
    return {'provenance':PROVENANCE,'embeddings':vectors.tolist()}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.path!='/health': return self.send_error(404)
        self.respond({'status':'ready',**PROVENANCE})
    def do_POST(self):
        if self.path!='/embed': return self.send_error(404)
        if self.headers.get('Origin'): return self.send_error(403)
        try: n=int(self.headers.get('Content-Length','0'))
        except ValueError:return self.send_error(400)
        if not 0<n<=20000:return self.send_error(413)
        if not SLOTS.acquire(blocking=False):return self.send_error(429,'text_encoder_busy')
        try:self.respond(embed(json.loads(self.rfile.read(n))['texts']))
        except Exception:self.send_error(422,'text_encoding_failed')
        finally:SLOTS.release()
    def respond(self,obj):
        data=json.dumps(obj,separators=(',',':')).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
class BoundedServer(ThreadingHTTPServer):
    request_queue_size=4
    # A single request worker prevents unbounded accepted-thread accumulation.
    def process_request(self,request,address):
        self.process_request_thread(request,address)
if __name__=='__main__': BoundedServer(('127.0.0.1',int(os.environ.get('SCOREBOOK_TEXT_PORT','8791'))),Handler).serve_forever()
