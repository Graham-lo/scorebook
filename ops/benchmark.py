"""Bounded local capacity smoke, not the 30-minute production acceptance test."""
import concurrent.futures,json,os,pathlib,re,subprocess,tempfile,time,urllib.request,statistics
ROOT=pathlib.Path(__file__).resolve().parents[1]
config=dict(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if line and not line.startswith('#'))
env={**os.environ,**config};env['DATABASE_URL']=env['DATABASE_URL'].rsplit('/',1)[0]+'/scorebook_test';env['SCOREBOOK_BIND']='127.0.0.1:8788'
with tempfile.TemporaryDirectory(prefix='scorebook-bench-') as temp:
 tokenfile=pathlib.Path(temp)/'token';env['SCOREBOOK_STORAGE']=str(pathlib.Path(temp)/'data')
 created=subprocess.check_output([str(ROOT/'target/release/scorebook'),'create-user','benchmark','--token-file',str(tokenfile)],env=env,text=True)
 owner=re.search(r'Created user ([0-9a-f-]{36})',created).group(1)
 sql=f"""INSERT INTO calls(id,owner_id,body,digest,original_text,instrument,market,timeframe)
 SELECT gen_random_uuid(),'{owner}',jsonb_build_object('original_text','突破回踩 合成容量测试 '||g,'criteria','[]'::jsonb),'synthetic_benchmark_only','突破回踩 合成容量测试 '||g,'BTCUSDT','usd_m','4h' FROM generate_series(1,100000) g;
 INSERT INTO call_state(owner_id,call_id) SELECT owner_id,id FROM calls WHERE owner_id='{owner}';
 ANALYZE calls; ANALYZE call_state;"""
 subprocess.run(['docker','compose','exec','-T','postgres','psql','-U','scorebook','-d','scorebook_test','-q'],cwd=ROOT,input=sql,text=True,check=True,capture_output=True)
 log=open(pathlib.Path(temp)/'server.log','w');server=subprocess.Popen([str(ROOT/'target/release/scorebook'),'serve'],cwd=ROOT,env=env,stdout=log,stderr=log)
 try:
  for _ in range(100):
   try:urllib.request.urlopen('http://127.0.0.1:8788/v1/health',timeout=1);break
   except Exception:time.sleep(.1)
  token=tokenfile.read_text().strip()
  def one(n):
   url='http://127.0.0.1:8788/v1/calls?limit=5'+('&q=%E7%A0%B4' if n%2 else '&market=usd_m&instrument=BTCUSDT')
   started=time.perf_counter();r=urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer '+token}),timeout=20)
   data=json.load(r);assert len(data['data']['items'])==5
   return (time.perf_counter()-started)*1000
  for n in range(30):one(n)
  started=time.perf_counter()
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:latencies=list(pool.map(one,range(1000)))
  seconds=time.perf_counter()-started;latencies.sort()
  result={'dataset':'100000 synthetic calls in isolated scorebook_test','samples':1000,'concurrency':8,'warmup':30,'p50_ms':round(statistics.median(latencies),2),'p95_ms':round(latencies[949],2),'p99_ms':round(latencies[989],2),'max_ms':round(max(latencies),2),'elapsed_seconds':round(seconds,2),'error_count':0,'limits':'Warm local API list/text search only; not 30-minute mixed-load, disk recovery, or full corpus image search acceptance.'}
  (ROOT/'docs/benchmark-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
 finally:
  server.terminate();server.wait(timeout=10);log.close()
  subprocess.run(['docker','compose','exec','-T','postgres','psql','-U','scorebook','-d','scorebook_test','-q'],cwd=ROOT,input=f"DELETE FROM calls WHERE owner_id='{owner}'; DELETE FROM api_keys WHERE owner_id='{owner}'; DELETE FROM users WHERE id='{owner}';",text=True,check=True,capture_output=True)
