"""Local encoder transport/batch/concurrency check. Images stay in memory; no cloud calls."""
import concurrent.futures,io,json,pathlib,struct,time,urllib.request,urllib.error
from PIL import Image,ImageDraw
ROOT=pathlib.Path(__file__).resolve().parents[1]
im=Image.new('RGB',(1280,640),(18,20,24));draw=ImageDraw.Draw(im)
for n in range(96):
 y=500-n*3;draw.line((n*12+12,y-20,n*12+12,y+25),fill=(30,180,110));draw.rectangle((n*12+8,y-8,n*12+16,y+12),fill=(30,180,110))
b=io.BytesIO();im.save(b,format='PNG');png=b.getvalue()
def encode(count):
 body=struct.pack('>I',count)+b''.join(struct.pack('>I',len(png))+png for _ in range(count));start=time.perf_counter()
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8790/embed-batch',data=body,headers={'Content-Type':'application/octet-stream'}),timeout=20) as r:value=json.load(r)
 assert len(value['features'])==count
 for feature in value['features']:
  assert len(feature['embedding'])==384 and feature['model_id']=='dinov2-small-v1'
  assert feature['provenance']['weights_sha256']=='ae1e99fcefd534ed978cdeb8326f08030c96e28b7a81ffcbc98a857c84d14be1'
 return (time.perf_counter()-start)*1000,value['features'][0]['embedding']
single=encode(1)[1];batch_time,batch=encode(8);dot=sum(a*b for a,b in zip(single,batch));assert dot>.99999
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as p:values=sorted(v[0] for v in p.map(lambda _:encode(1),range(40)))
try:urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8790/embed',data=png),timeout=3);raise AssertionError('old route still present')
except urllib.error.HTTPError as e:assert e.code==404
result={'scope':'Local encoder HTTP including PNG decode, preprocessing and CPU inference; excludes API upload/vector query','concurrency':2,'samples':40,'p95_ms':round(values[37],2),'max_ms':round(max(values),2),'batch8_ms':round(batch_time,2),'batch_single_cosine':dot,'weights_verified':True,'old_embed_route':404}
(ROOT/'docs/vision-acceptance-v3.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
