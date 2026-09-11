"""Isolated 30-minute mixed workload, explicit process failure, API percentiles and streaming export RSS.
Run with a Python environment containing psycopg. Only this script's uniquely named database is removed.
"""
import collections, concurrent.futures, hashlib, json, os, pathlib, re, statistics, subprocess, tempfile, threading, time, urllib.request, urllib.parse, uuid
import psycopg
from psycopg import sql
ROOT=pathlib.Path(__file__).resolve().parents[1]
config=dict(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if line and not line.startswith('#'))
env={**os.environ,**config}; dbname='scorebook_accept_'+uuid.uuid4().hex[:12]
admin=env['DATABASE_URL'].rsplit('/',1)[0]+'/postgres'; env['DATABASE_URL']=env['DATABASE_URL'].rsplit('/',1)[0]+'/'+dbname
report_name=os.getenv('SCOREBOOK_ACCEPT_REPORT','acceptance-v3.json');assert pathlib.Path(report_name).name==report_name and report_name.endswith('.json')
report_path=ROOT/'docs'/report_name
seconds=int(os.getenv('SCOREBOOK_ACCEPT_SECONDS','1800')); env['SCOREBOOK_BIND']='127.0.0.1:8788'; env['RUST_LOG']='warn'
result={'duration_requested_seconds':seconds,'dataset':'100000 synthetic calls; 1000000 synthetic events; no market source data','database':dbname,'release_sha256':hashlib.sha256((ROOT/'target/release/scorebook').read_bytes()).hexdigest(),'limits':'Local mixed-load acceptance; not production sizing or human chart-quality validation.'}
with psycopg.connect(admin,autocommit=True) as c:c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(dbname)))
workspace=tempfile.TemporaryDirectory(prefix='scorebook-v3-accept-');tmp=pathlib.Path(workspace.name);env['SCOREBOOK_STORAGE']=str(tmp/'data')
log=open(tmp/'runtime.log','w'); server=None;worker=None;stop=threading.Event();lock=threading.Lock();faulting=threading.Event();metrics=collections.defaultdict(list);errors=collections.Counter();total=collections.Counter();token=''
def launch(kind):return subprocess.Popen([str(ROOT/'target/release/scorebook'),kind],cwd=ROOT,env=env,stdout=log,stderr=log)
def api(path,body=None,key=None):
    headers={'Authorization':'Bearer '+token}
    if body is not None:headers['Content-Type']='application/json'
    if key:headers['Idempotency-Key']=key
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8788'+path,data=None if body is None else json.dumps(body).encode(),headers=headers),timeout=20) as r:return json.load(r)['data']
def ready():
    for _ in range(100):
        try:urllib.request.urlopen('http://127.0.0.1:8788/v1/health',timeout=1);return
        except Exception:time.sleep(.1)
    raise RuntimeError('server readiness timeout')
def summary(values):
    values=sorted(values)
    return {'samples':len(values),'p50_ms':round(statistics.median(values),2),'p95_ms':round(values[int((len(values)-1)*.95)],2),'max_ms':round(max(values),2)} if values else {}
def rss(pid):return int(subprocess.check_output(['ps','-o','rss=','-p',str(pid)],text=True).strip())*1024
try:
    created=subprocess.check_output([str(ROOT/'target/release/scorebook'),'create-user','acceptance','--token-file',str(tmp/'token')],env=env,cwd=ROOT,text=True)
    owner=re.search(r'Created user ([0-9a-f-]{36})',created).group(1);token=(tmp/'token').read_text().strip()
    with psycopg.connect(env['DATABASE_URL'],autocommit=True) as c:
        c.execute("INSERT INTO calls(id,owner_id,body,digest,original_text,instrument,market,timeframe) SELECT gen_random_uuid(),%s,jsonb_build_object('original_text',t,'criteria','[]'::jsonb),'synthetic-only',t,'BTCUSDT','usd_m','4h' FROM (SELECT CASE WHEN g=1 THEN 'rare-canary-unique' ELSE '突破回踩 synthetic '||g END t FROM generate_series(1,100000)g)q",(owner,))
        c.execute('INSERT INTO call_state(owner_id,call_id) SELECT owner_id,id FROM calls WHERE owner_id=%s',(owner,)); c.execute('ANALYZE calls');c.execute('ANALYZE call_state')
    server=launch('serve');worker=launch('worker');ready()
    paths={'list':'/v1/calls?limit=20&instrument=BTCUSDT','common':'/v1/calls?limit=20&q='+urllib.parse.quote('突破'),'rare':'/v1/calls?limit=20&q=rare-canary-unique','zero':'/v1/calls?limit=20&q=never-present-token','cjk_zero':'/v1/calls?limit=20&q='+urllib.parse.quote('熊')}
    def measured(name):
        start=time.perf_counter();data=api(paths[name]);elapsed=(time.perf_counter()-start)*1000
        expected=1 if name=='rare' else 0 if name in ('zero','cjk_zero') else 20
        assert len(data['items'])==expected
        return elapsed
    result['cold_first_request']={name:round(measured(name),2) for name in paths} # Fresh API, not an OS disk cache flush.
    result['warm_api_20_concurrent']={}
    for name in paths:
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:values=list(pool.map(lambda _:measured(name),range(200)))
        result['warm_api_20_concurrent'][name]=summary(values)
    print(json.dumps({'phase':'warm_api','results':result['warm_api_20_concurrent']}),flush=True)
    # Real API draft save loop, with monotonic revision and stable identity on retry.
    created=api('/v1/calls',{'original_text':'长期复盘压力测试'},'review-call');call_id=created['id']
    started=time.monotonic()
    def reader(n):
        names=list(paths)
        while not stop.is_set():
            name=names[n%len(names)];n+=1
            try:
                elapsed=measured(name)
                with lock:
                    total[name]+=1;metrics[name].append(elapsed)
                    if len(metrics[name])>20000:metrics[name].pop(0)
            except Exception:
                with lock:errors['controlled_restart' if faulting.is_set() else 'unexpected']+=1
            stop.wait(.25)
    def writer():
        rev=0
        while not stop.is_set():
            key=str(uuid.uuid4());body={'expected_draft_revision':rev,'note':f'长期复盘草稿 {rev}','better_play':None,'vs_last':'new'}
            while not stop.is_set():
                try:
                    saved=api(f'/v1/calls/{call_id}/review-draft',body,key);rev=saved['revision'];total['draft_saves']+=1;break
                except Exception:
                    with lock:errors['controlled_restart' if faulting.is_set() else 'unexpected_write']+=1
                    stop.wait(1)
            stop.wait(2)
        result['last_draft_revision']=rev
    threads=[threading.Thread(target=reader,args=(i,),daemon=True) for i in range(8)]+[threading.Thread(target=writer,daemon=True)]
    for t in threads:t.start()
    # Export a million synthetic events through the real maintenance worker and sample its resident memory.
    with psycopg.connect(env['DATABASE_URL'],autocommit=True) as c:
        c.execute("INSERT INTO events(id,owner_id,call_id,kind,body) SELECT gen_random_uuid(),%s,%s,'synthetic.acceptance',jsonb_build_object('n',g,'note',repeat('x',128)) FROM generate_series(1,1000000)g",(owner,call_id))
    baseline_rss=rss(worker.pid);peak_rss=baseline_rss;eid=api('/v1/exports',{},'million-row-export')['job_id'];export_start=time.monotonic()
    while True:
        peak_rss=max(peak_rss,rss(worker.pid));job=api('/v1/jobs/'+eid)
        if job['status']=='succeeded':break
        if job['status'] in ('failed','needs_attention'):raise RuntimeError('export failed: '+str(job.get('error_code')))
        if time.monotonic()-export_start>300:raise RuntimeError('export timeout')
        time.sleep(.2)
    export_path=tmp/'data'/'exports'/owner/eid
    verified=json.loads(subprocess.check_output([str(ROOT/'target/release/scorebook'),'verify-export',str(export_path)],env=env,cwd=ROOT,text=True))
    result['million_row_export']={'seconds':round(time.monotonic()-export_start,2),'rows':verified['rows'],'baseline_rss_bytes':baseline_rss,'peak_rss_bytes':peak_rss,'growth_bytes':peak_rss-baseline_rss,'verified':verified['status']}
    print(json.dumps({'phase':'export','result':result['million_row_export']}),flush=True)
    # Two intentional process interruptions; no persistent fallback and no separate old server.
    faulting.set();server.kill();server.wait();server=launch('serve');ready();faulting.clear()
    worker.kill();worker.wait();worker=launch('worker');result['faults']=['API SIGKILL and same-release restart','worker SIGKILL and same-release restart']
    last=0
    while time.monotonic()-started<seconds:
        elapsed=int(time.monotonic()-started)
        if elapsed-last>=60:
            last=elapsed
            print(json.dumps({'phase':'mixed_load','elapsed_seconds':elapsed,'requests':sum(total.values()),'errors':dict(errors)}),flush=True)
        time.sleep(1)
    stop.set()
    for t in threads:t.join(timeout=25)
    final=api(f'/v1/calls/{call_id}/review-draft')
    assert final['draft']['revision']==result['last_draft_revision']
    result.update({'elapsed_seconds':round(time.monotonic()-started,2),'mixed_load':{n:summary(v) for n,v in metrics.items()},'totals':dict(total),'errors':dict(errors),'draft_recovered':True})
    report_path.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
    print(json.dumps({'phase':'completed','result_file':'docs/'+report_name,'errors':dict(errors)}),flush=True)
finally:
    stop.set()
    for process in [server,worker]:
        if process and process.poll() is None:
            process.terminate()
            try:process.wait(timeout=15)
            except subprocess.TimeoutExpired:process.kill();process.wait()
    log.close()
    # Preserve a failure report without private payloads before removing the isolated synthetic DB.
    if not report_path.exists():report_path.with_name(report_path.stem+'-partial.json').write_text(json.dumps(result,indent=2)+'\n')
    with psycopg.connect(admin,autocommit=True) as c:c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(dbname)))
    workspace.cleanup()
