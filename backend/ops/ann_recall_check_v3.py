"""Stratified queries across the retained isolated million-vector corpus, including a 10% symbol filter."""
import concurrent.futures,json,pathlib,re,sys,time,uuid
import psycopg
ROOT=pathlib.Path(__file__).resolve().parents[1];name=sys.argv[1];assert re.fullmatch('scorebook_ann_[a-f0-9]+',name)
config=dict(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if line and not line.startswith('#'));url=config['DATABASE_URL'].rsplit('/',1)[0]+'/'+name
from ann_bench_common import public_query, configure
query=public_query()
def params(v,symbol):return {'q1':'2030-01-01T00:00:00Z','q2':symbol,'q3':'usd_m','q4':'1h','q5':v}
result={'rows':1000000,'dimension':192,'query_distribution':'40 distinct synthetic clusters at offsets i*19997; each unfiltered and ETHUSDT 10% symbol filter','ef_search':1000,'scan_mem_multiplier':4,'work_mem':'32MB','max_scan_tuples':1000000,'candidate_budget':3000,'mode':'relaxed_order','scope':'actual production SQL; search SQL timing only, excludes image encoding and HTTP','database':name,'details':[]}
with psycopg.connect(url,autocommit=True) as c:
 configure(c);probes=[c.execute('SELECT embedding::text FROM public_market.features WHERE id=%s',(uuid.UUID(int=i*19997+1),)).fetchone()[0] for i in range(40)]
 for symbol in [None,'ETHUSDT']:
  for i,v in enumerate(probes):
   if i==0:
    plan=c.execute('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query,params(v,symbol)).fetchone()[0];result.setdefault('plans',[]).append(plan);assert 'public_profile_ann' in json.dumps(plan), 'Expected HNSW for million-vector corpus'
   approx=c.execute(query,params(v,symbol)).fetchall()
   c.execute('SET enable_indexscan=off');c.execute('SET enable_bitmapscan=off');exact=c.execute(query.replace('LIMIT 1000','LIMIT 20'),params(v,symbol)).fetchall();c.execute('RESET enable_indexscan');c.execute('RESET enable_bitmapscan')
   score=len({r[0] for r in approx[:20]}&{r[0] for r in exact})/len(exact)
   result['details'].append({'probe':i,'symbol':symbol,'recall_at_20':score,'candidates':len(approx)})
  print(json.dumps({'phase':'recall','filter':symbol,'mean':sum(d['recall_at_20'] for d in result['details'][-40:])/40}),flush=True)
def reader(n):
 with psycopg.connect(url,autocommit=True) as c:
  configure(c);times=[]
  for i in range(20):
   t=time.perf_counter();rows=c.execute(query,params(probes[(i+n*5)%40],'ETHUSDT' if i%2 else None)).fetchall();times.append((time.perf_counter()-t)*1000)
  return times
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as p:lat=sorted(sum(p.map(reader,range(8)),[]))
result.update({'recall_at_20_mean':sum(d['recall_at_20'] for d in result['details'])/80,'recall_at_20_min':min(d['recall_at_20'] for d in result['details']),'p95_ms':round(lat[int(.95*(len(lat)-1))],2),'max_ms':round(max(lat),2),'concurrency':8,'samples':len(lat)})
(ROOT/'docs/ann-acceptance-v3.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ('details','plans')}))
