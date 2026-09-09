"""Isolated v4 partitioned ANN acceptance, synthetic vectors only; no OHLC or images."""
import concurrent.futures,datetime,json,os,pathlib,re,subprocess,time,uuid
import numpy as np
import psycopg
from psycopg import sql
ROOT=pathlib.Path(__file__).resolve().parents[1]
config=dict(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if line and not line.startswith('#'))
env={**os.environ,**config};base=env['DATABASE_URL'].rsplit('/',1)[0];dbname='scorebook_ann_v4_'+uuid.uuid4().hex[:12];env['DATABASE_URL']=base+'/'+dbname
N=int(os.getenv('SCOREBOOK_ANN_ROWS','1000000'));D=192
source=(ROOT/'crates/infrastructure/src/application/chart_search/repository.rs').read_text()
query=re.search(r'"(WITH candidates AS MATERIALIZED \(SELECT id,market,symbol,timeframe.*?LIMIT 1000)"',source).group(1)
query=re.sub(r'\$(\d+)',lambda m:'%(q'+m[1]+')s',query)
from ann_bench_common import configure
result={'rows':N,'dimensions':D,'schema':'v4_partitioned','query_source':'chart_search/repository.rs::public_candidates','data':'synthetic clustered embeddings; not image quality ground truth','concurrency':8}
with psycopg.connect(base+'/postgres',autocommit=True) as c:c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(dbname)))
try:
 subprocess.run([str(ROOT/'target/debug/scorebook'),'migrate'],env=env,cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
 rng=np.random.default_rng(83);centres=rng.standard_normal((1000,D)).astype(np.float32);centres/=np.linalg.norm(centres,axis=1)[:,None]
 probes=[];epoch=datetime.datetime(2010,1,1,tzinfo=datetime.timezone.utc);tfs=['1m','5m','15m','1h','4h','1d'];periods=[60,300,900,3600,14400,86400];started=time.monotonic()
 with psycopg.connect(env['DATABASE_URL'],autocommit=True) as c:
  c.execute('DROP INDEX public_market.public_geometry_ann')
  for offset in range(0,N,2000):
   length=min(2000,N-offset);arr=centres[np.arange(offset,offset+length)%1000]+rng.standard_normal((length,D)).astype(np.float32)*.06;arr/=np.linalg.norm(arr,axis=1)[:,None]
   rows=[];loc=[]
   for i,vector in enumerate(arr):
    n=offset+i;tf=n%6;market='coin_m' if n%5==0 else 'usd_m';symbol=('ETHUSD_PERP' if n%10==0 else 'BTCUSD_PERP') if market=='coin_m' else ('ETHUSDT' if n%10==1 else 'BTCUSDT')
    encoded='['+','.join(format(float(x),'.6g') for x in vector)+']';at=epoch+datetime.timedelta(minutes=n);end=at+datetime.timedelta(seconds=periods[tf]*[64,128,256][n%3]);ident=uuid.UUID(int=n+1)
    rows.append((ident,market,symbol,tfs[tf],at,end,[64,128,256][n%3],'candle-geometry-v2',encoded,'synthetic-'+str(n),'ohlc-geometry-resample64-v2',True));loc.append((ident,market,tfs[tf]))
    if n in {i*19997 for i in range(24)}:probes.append(encoded)
   with c.transaction():
    with c.cursor().copy('COPY public_market.feature_locator(id,market,timeframe) FROM STDIN') as cp:
     for row in loc:cp.write_row(row)
    with c.cursor().copy('COPY public_market.features(id,market,symbol,timeframe,start_at,end_at,bars_count,model_id,embedding,input_hash,render_version,published) FROM STDIN') as cp:
     for row in rows:cp.write_row(row)
   if offset%100000==0:print(json.dumps({'phase':'copy','rows':offset+length}),flush=True)
  result['copy_seconds']=round(time.monotonic()-started,2);started=time.monotonic();c.execute("SET maintenance_work_mem='512MB'");c.execute('SET max_parallel_maintenance_workers=0')
  print(json.dumps({'phase':'build_hnsw','rows':N}),flush=True)
  c.execute("CREATE INDEX public_geometry_ann ON public_market.features USING hnsw ((embedding::vector(192)) vector_cosine_ops) WHERE model_id='candle-geometry-v2' AND published")
  c.execute('ANALYZE public_market.features');result['index_seconds']=round(time.monotonic()-started,2);configure(c)
  def params(vector,filtered=False):return {'q1':vector,'q2':'2030-01-01T00:00:00Z','q3':'ETHUSDT' if filtered else None,'q4':'usd_m' if filtered else None,'q5':'1h' if filtered else None,'q6':[64,128,256]}
  result['plans']={}
  for filtered in [False,True]:
   plan=c.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,params(probes[0],filtered)).fetchone()[0];result['plans'][str(filtered)]=plan
   assert 'hnsw' in json.dumps(plan).lower() or 'embedding_idx' in json.dumps(plan), 'HNSW index absent from production plan'
  recalls=[]
  for filtered in [False,True]:
   for vector in probes[:12]:
    approx=c.execute(query,params(vector,filtered)).fetchall()
    c.execute('SET enable_indexscan=off');c.execute('SET enable_bitmapscan=off')
    exact=c.execute(query.replace('LIMIT 3000','LIMIT 20').replace('LIMIT 1000','LIMIT 20'),params(vector,filtered)).fetchall()
    c.execute('RESET enable_indexscan');c.execute('RESET enable_bitmapscan')
    recalls.append(len({r[0] for r in approx[:20]} & {r[0] for r in exact})/len(exact))
  result['recall_at_20_mean']=sum(recalls)/len(recalls);result['recall_at_20_min']=min(recalls);result['recall_queries']=len(recalls)
 def reader(n):
  with psycopg.connect(env['DATABASE_URL'],autocommit=True) as c:
   configure(c);times=[]
   for i in range(12):
    started=time.perf_counter();rows=c.execute(query,params(probes[(n+i)%len(probes)],i%2==1)).fetchall();times.append((time.perf_counter()-started)*1000);assert len(rows)==1000
   return times
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:times=sum(pool.map(reader,range(8)),[])
 times.sort();result.update(samples=len(times),p50_ms=round(times[len(times)//2],2),p95_ms=round(times[int(.95*(len(times)-1))],2),max_ms=round(max(times),2))
 (ROOT/'docs/ann-acceptance-v4.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='plans'}),flush=True)
finally:
 with psycopg.connect(base+'/postgres',autocommit=True) as c:c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(dbname)))
