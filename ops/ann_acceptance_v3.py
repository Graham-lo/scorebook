"""A million synthetic derived vectors: actual public query EXPLAIN, Recall@20 vs test-only exact, 8 readers.
Requires psycopg/numpy. No OHLC, exchange files or user images are generated or stored.
"""
import concurrent.futures, json, os, pathlib, re, subprocess, time, uuid
import numpy as np
import psycopg
from psycopg import sql
ROOT=pathlib.Path(__file__).resolve().parents[1]
config=dict(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if line and not line.startswith('#'))
env={**os.environ,**config};base=env['DATABASE_URL'].rsplit('/',1)[0];dbname='scorebook_ann_'+uuid.uuid4().hex[:12];env['DATABASE_URL']=base+'/'+dbname
N=int(os.getenv('SCOREBOOK_ANN_ROWS','1000000'));dimension=192
with psycopg.connect(base+'/postgres',autocommit=True) as c:c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(dbname)))
result={'database':dbname,'ef_search':1000,'scan_mem_multiplier':4,'rows':N,'dimension':dimension,'vectors':'Deterministic synthetic clusters with noise, not semantic chart-quality ground truth','query_source':'crates/infrastructure/src/application/history.rs','concurrency':8,'work_mem':'32MB','max_scan_tuples':1000000,'candidate_budget':3000,'mode':'relaxed_order','query_distribution':'40 distinct clusters at offsets i*19997, each unfiltered and ETHUSDT 10% filter'}
try:
 subprocess.run([str(ROOT/'target/release/scorebook'),'migrate'],env=env,cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
 from ann_bench_common import public_query, configure
 query=public_query()
 def params(vector,symbol=None):return {'q1':'2030-01-01T00:00:00Z','q2':symbol,'q3':'usd_m','q4':'1h','q5':vector}
 rng=np.random.default_rng(83);centres=rng.standard_normal((1000,dimension)).astype(np.float32);centres/=np.linalg.norm(centres,axis=1)[:,None]
 probes=[];started=time.monotonic()
 with psycopg.connect(env['DATABASE_URL'],autocommit=True) as c:
  c.execute('DROP INDEX public_market.public_profile_ann')
  with c.cursor().copy('COPY public_market.features(id,market,symbol,timeframe,start_at,end_at,bars_count,model_id,embedding,input_hash,render_version,published) FROM STDIN') as copy:
   import datetime
   epoch=datetime.datetime(2010,1,1,tzinfo=datetime.timezone.utc)
   for offset in range(0,N,1000):
    length=min(1000,N-offset);arr=centres[np.arange(offset,offset+length)%1000]+rng.standard_normal((length,dimension)).astype(np.float32)*.06;arr/=np.linalg.norm(arr,axis=1)[:,None]
    for i,vector in enumerate(arr):
     n=offset+i;encoded='['+','.join(format(float(x),'.6g') for x in vector)+']'
     start=epoch+datetime.timedelta(seconds=n*60);end=start+datetime.timedelta(hours=64)
     copy.write_row((uuid.UUID(int=n+1),'usd_m','BTCUSDT' if n%10 else 'ETHUSDT','1h',start,end,64,'candle-profile-v1',encoded,'synthetic-'+str(n),'chart-raster-v1',True))
     if n in {i*19997 for i in range(40)}:probes.append(encoded)
    if offset%100000==0:print(json.dumps({'phase':'insert','rows':offset+length}),flush=True)
  result['copy_seconds']=round(time.monotonic()-started,2)
  c.execute("SET maintenance_work_mem='512MB'");c.execute('SET max_parallel_maintenance_workers=0');started=time.monotonic()
  print(json.dumps({'phase':'build_hnsw','rows':N}),flush=True)
  c.execute("CREATE INDEX public_profile_ann ON public_market.features USING hnsw ((embedding::vector(192)) vector_cosine_ops) WHERE model_id='candle-profile-v1' AND published")
  result['index_seconds']=round(time.monotonic()-started,2);c.execute('ANALYZE public_market.features')
  configure(c)
  plan=c.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query,params(probes[0])).fetchone()[0]
  result['plan']=plan
  assert 'public_profile_ann' in json.dumps(plan), 'Production query did not choose the HNSW expression index'
  recalls=[];latencies=[]
  for symbol in [None,'ETHUSDT']:
   for vector in probes:
    begin=time.perf_counter();approx=c.execute(query,params(vector,symbol)).fetchall();latencies.append((time.perf_counter()-begin)*1000)
    # The only exact reference path is inside this test and is never called by production.
    c.execute('SET enable_indexscan=off');c.execute('SET enable_bitmapscan=off')
    exact=c.execute(query.replace('LIMIT 1000','LIMIT 20'),params(vector,symbol)).fetchall()
    c.execute('RESET enable_indexscan');c.execute('RESET enable_bitmapscan')
    recalls.append(len({r[0] for r in approx[:20]} & {r[0] for r in exact})/len(exact))
    result.setdefault('recall_details',[]).append({'symbol':symbol,'recall':recalls[-1],'candidates':len(approx)})
  result['recall_at_20_mean']=sum(recalls)/len(recalls);result['recall_at_20_min']=min(recalls);result['recall_queries']=len(recalls)
 def reader(n):
  with psycopg.connect(env['DATABASE_URL'],autocommit=True) as c:
   configure(c)
   samples=[]
   for i in range(20):
    begin=time.perf_counter();rows=c.execute(query,params(probes[(n+i)%len(probes)],'ETHUSDT' if i%2 else None)).fetchall();samples.append((time.perf_counter()-begin)*1000);assert len(rows)==1000
   return samples
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:values=sum(pool.map(reader,range(8)),[])
 values.sort();result['p95_ms']=round(values[int(.95*(len(values)-1))],2);result['samples']=len(values);result['max_ms']=round(max(values),2)
 (ROOT/'docs/ann-acceptance-v3.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k!='plan'}),flush=True)
finally:
 if os.getenv('SCOREBOOK_ANN_KEEP_DB')=='1':print(json.dumps({'retained_synthetic_database':dbname}),flush=True)
 else:
  with psycopg.connect(base+'/postgres',autocommit=True) as c:c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(dbname)))
