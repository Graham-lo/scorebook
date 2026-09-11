"""Sparse review buckets against 100,000 synthetic records, isolated from user data."""
import concurrent.futures,json,os,pathlib,re,subprocess,tempfile,time,urllib.request,uuid
import psycopg
from psycopg import sql
ROOT=pathlib.Path(__file__).resolve().parents[1]
config=dict(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if line and not line.startswith('#'))
env={**os.environ,**config};base=env['DATABASE_URL'].rsplit('/',1)[0];name='scorebook_review_'+uuid.uuid4().hex[:12];env['DATABASE_URL']=base+'/'+name;env['SCOREBOOK_BIND']='127.0.0.1:8789';env['RUST_LOG']='warn'
with psycopg.connect(base+'/postgres',autocommit=True) as c:c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
server=None
with tempfile.TemporaryDirectory(prefix='scorebook-review-') as temp:
 p=pathlib.Path(temp);env['SCOREBOOK_STORAGE']=str(p/'data')
 try:
  out=subprocess.check_output([str(ROOT/'target/release/scorebook'),'create-user','review-benchmark','--token-file',str(p/'token')],env=env,cwd=ROOT,text=True);owner=re.search(r'Created user ([0-9a-f-]{36})',out).group(1)
  with psycopg.connect(env['DATABASE_URL'],autocommit=True) as c:
   c.execute("INSERT INTO calls(id,owner_id,body,digest,original_text) SELECT gen_random_uuid(),%s,'{}','synthetic','synthetic review queue' FROM generate_series(1,100000)",(owner,));c.execute('INSERT INTO call_state(owner_id,call_id) SELECT owner_id,id FROM calls WHERE owner_id=%s',(owner,))
   ids=[r[0] for r in c.execute('SELECT id FROM calls WHERE owner_id=%s ORDER BY submitted_at LIMIT 10',(owner,)).fetchall()]
   for id in ids[:5]:
    c.execute("INSERT INTO review_drafts(owner_id,call_id,body) VALUES(%s,%s,'{}')",(owner,id));c.execute('UPDATE call_state SET draft_revision=1 WHERE owner_id=%s AND call_id=%s',(owner,id))
   for id in ids[5:7]:c.execute("INSERT INTO reviews(id,owner_id,call_id,body) VALUES(gen_random_uuid(),%s,%s,'{}')",(owner,id))
   for id in ids[7:]:c.execute("INSERT INTO review_preferences(owner_id,call_id,snoozed_until) VALUES(%s,%s,now()+interval '1 day')",(owner,id))
   c.execute('INSERT INTO review_queue_projection SELECT * FROM review_queue_source WHERE owner_id=%s',(owner,))
   for table in ['calls','call_state','reviews','review_drafts','review_preferences','review_queue_projection']:c.execute('ANALYZE '+table)
  log=open(p/'log','w');server=subprocess.Popen([str(ROOT/'target/release/scorebook'),'serve'],cwd=ROOT,env=env,stdout=log,stderr=log)
  for _ in range(100):
   try:urllib.request.urlopen('http://127.0.0.1:8789/v1/health',timeout=1);break
   except Exception:time.sleep(.1)
  token=(p/'token').read_text().strip()
  def one(bucket):
   t=time.perf_counter()
   with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8789/v1/review-queue?bucket='+bucket,headers={'Authorization':'Bearer '+token}),timeout=20) as r:items=json.load(r)['data']['items']
   assert len(items)=={'needs_review':20,'in_progress':5,'completed':2,'snoozed':3}[bucket]
   return (time.perf_counter()-t)*1000
  result={'records':100000,'concurrency':20,'sparse_records':'5 drafts, 2 published reviews, 3 snoozed; oldest submissions, so ordered call scans cannot stop early','buckets':{}}
  for bucket in ['needs_review','in_progress','completed','snoozed']:
   with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:v=sorted(pool.map(lambda _:one(bucket),range(200)))
   result['buckets'][bucket]={'samples':len(v),'p95_ms':round(v[189],2),'max_ms':round(max(v),2)}
  (ROOT/'docs/review-queue-acceptance-v3.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
 finally:
  if server:server.terminate();server.wait(timeout=15)
  with psycopg.connect(base+'/postgres',autocommit=True) as c:c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
