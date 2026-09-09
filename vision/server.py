"""Local-only DINOv2 encoder. No image upload to cloud; model files fetched by setup.py."""
import hashlib, io, json, os, threading, struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import torch
from PIL import Image, ImageOps
from transformers import AutoModel

ROOT = Path(__file__).parent / "models" / "dinov2-small"
REVISION = "150c8e7bb7cef2d30ec31b13a517af14840ee3f7"
MODEL_ID = "dinov2-small-v1"
torch.set_num_threads(2)
MODEL = AutoModel.from_pretrained(ROOT, local_files_only=True, trust_remote_code=False, use_safetensors=True).eval()
WEIGHTS = hashlib.sha256((ROOT / "model.safetensors").read_bytes()).hexdigest()
LOCK = threading.Semaphore(1)
REQUEST_SLOTS = threading.BoundedSemaphore(2)
Image.MAX_IMAGE_PIXELS = 40_000_000

def preprocess(data):
    with Image.open(io.BytesIO(data)) as source:
        if source.width > 8192 or source.height > 8192:
            raise ValueError("image_too_large")
        im = ImageOps.contain(source.convert("RGB"), (224, 224), Image.Resampling.BICUBIC)
        canvas = Image.new("RGB", (224, 224), (127, 127, 127))
        canvas.paste(im, ((224-im.width)//2, (224-im.height)//2))
    import numpy as np
    x = torch.from_numpy(np.array(canvas, dtype=np.float32)/255.0).permute(2,0,1)
    return (x - torch.tensor([.485,.456,.406])[:,None,None]) / torch.tensor([.229,.224,.225])[:,None,None]

def embed_batch(payload):
    count, = struct.unpack_from(">I", payload, 0)
    if not 1 <= count <= 8: raise ValueError("invalid_batch_count")
    tensors=[]; offset=4
    for _ in range(count):
        size, = struct.unpack_from(">I", payload, offset); offset+=4
        if not 0 < size <= 20*1024*1024 or offset+size>len(payload): raise ValueError("invalid_frame")
        tensors.append(preprocess(payload[offset:offset+size])); offset+=size
    if offset!=len(payload): raise ValueError("trailing_data")
    with LOCK, torch.inference_mode():
        v=MODEL(pixel_values=torch.stack(tensors)).last_hidden_state[:,0,:]
        vectors=torch.nn.functional.normalize(v,dim=-1).tolist()
    provenance={"model":"facebook/dinov2-small","revision":REVISION,"weights_sha256":WEIGHTS,"preprocessing":"letterbox224-bicubic-imagenet-v1","pooling":"cls-l2","dimension":384,"local":True,"structure_quality":"unvalidated"}
    return {"features":[{"model_id":MODEL_ID,"embedding":v,"provenance":provenance} for v in vectors]}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass  # Never copy user image data into logs.
    def do_GET(self):
        if self.path != "/health": return self.send_error(404)
        self.respond({"status":"ready","model_id":MODEL_ID,"revision":REVISION,"weights_sha256":WEIGHTS})
    def do_POST(self):
        if self.path != "/embed-batch": return self.send_error(404)
        if self.headers.get("Origin"): return self.send_error(403)
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > 32*1024*1024: return self.send_error(413)
        if not REQUEST_SLOTS.acquire(blocking=False): return self.send_error(429, "image_queue_busy")
        try: self.respond(embed_batch(self.rfile.read(n)))
        except Exception: self.send_error(422, "image_encoding_failed")
        finally: REQUEST_SLOTS.release()
    def respond(self, value):
        payload=json.dumps(value).encode(); self.send_response(200)
        self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(payload)))
        self.end_headers();self.wfile.write(payload)

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1",8790),Handler).serve_forever()
