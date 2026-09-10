"""Bounded live Binance verification. Always drops its DB/files before returning.

Uses two contracts, two periods and 512 closed bars per recent range. Never saves
public OHLC or generated charts; only the supplied user screenshot is copied to
an isolated attachment directory, which is deleted in finally.
"""
import hashlib, json, os, pathlib, shutil, socket, subprocess, tempfile, time, uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import psycopg
from psycopg import sql
from psycopg.types.json import Jsonb

ROOT = pathlib.Path(__file__).resolve().parents[1]
IMAGE_ID = '50773d78-84a7-43ef-8240-cec3b9f03383'
SYMBOLS = ['BTCUSDT', 'ETHUSDT']
PERIODS = {'1h': 3600, '4h': 14400}
TERMINAL = {'succeeded','failed','needs_attention','blocked_capability','awaiting_input','cancelled'}

def main():
    primary = os.environ['DATABASE_URL']
    name = 'scorebook_live_period_' + uuid.uuid4().hex[:12]
    dburl = urlunsplit(urlsplit(primary)._replace(path='/' + name))
    report = {'scope': {'symbols': SYMBOLS, 'intervals': list(PERIODS), 'recent_bars_per_range':512}, 'checks':[], 'raw_market_persisted':False}
    processes=[]
    folder=tempfile.TemporaryDirectory(prefix='scorebook-live-period-')
    base=pathlib.Path(folder.name)
    failure=None
    with psycopg.connect(primary,autocommit=True) as admin:
        admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            # Real catalog metadata only; no existing prices/features/user records are copied.
            catalog=admin.execute("SELECT market,symbol,body,refreshed_at FROM instrument_catalog WHERE market='usd_m' AND symbol=ANY(%s)",(SYMBOLS,)).fetchall()
            lifecycle=admin.execute("SELECT market,symbol,onboard_at,delivery_at,status FROM public_market.instrument_lifecycles WHERE market='usd_m' AND symbol=ANY(%s)",(SYMBOLS,)).fetchall()
            assert len(catalog)==2 and len(lifecycle)==2
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            env=dict(os.environ,DATABASE_URL=dburl,SCOREBOOK_STORAGE=str(base/'data'),SCOREBOOK_BIND=f'127.0.0.1:{port}')
            binary=base/'scorebook'
            shutil.copy2(ROOT/'target/local-deploy/release/scorebook',binary)
            report['binary_sha256']=hashlib.file_digest(binary.open('rb'),'sha256').hexdigest()
            for args in [['migrate'],['create-user','live-period-test','--token-file',str(base/'token')]]:
                done=subprocess.run([str(binary),*args],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
                if done.returncode: raise RuntimeError('isolated setup failed: '+args[0])
            token=(base/'token').read_text().strip()
            with psycopg.connect(dburl,autocommit=True) as db:
                version=uuid.uuid4()
                db.execute("INSERT INTO public_market.catalog_versions(id,source,source_hash) VALUES(%s,'copied_verified_local_catalog','metadata-only')",(version,))
                for market,symbol,body,refreshed in catalog:
                    db.execute("INSERT INTO instrument_catalog(venue,market,symbol,body,refreshed_at) VALUES('binance',%s,%s,%s,%s)",(market,symbol,Jsonb(body),refreshed))
                for market,symbol,onboard,delivery,status in lifecycle:
                    db.execute("INSERT INTO public_market.instrument_lifecycles(market,symbol,onboard_at,delivery_at,status,catalog_version) VALUES(%s,%s,%s,%s,%s,%s)",(market,symbol,onboard,delivery,status,version))
                for command in ['serve','worker']:
                    processes.append(subprocess.Popen([str(binary),command],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
                def request(method,path,body=None,raw=False,content_type=None):
                    payload=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
                    headers={'Authorization':'Bearer '+token}
                    if method=='POST':headers['Idempotency-Key']=str(uuid.uuid4())
                    if payload is not None:headers['Content-Type']=content_type or 'application/json'
                    req=Request(f'http://127.0.0.1:{port}'+path,data=payload,method=method,headers=headers)
                    try:
                        with urlopen(req,timeout=90) as response:
                            content=response.read()
                            return (response.status,content) if raw else (response.status,json.loads(content))
                    except HTTPError as error:
                        return error.code,json.loads(error.read())
                def ok(path,body=None):
                    code,value=request('GET' if body is None else 'POST',path,body)
                    if code!=200:raise RuntimeError(path+': '+str(code)+' '+value.get('error',{}).get('code',''))
                    return value['data']
                def wait_job(job_id):
                    deadline=time.monotonic()+300
                    while time.monotonic()<deadline:
                        value=ok('/v1/jobs/'+job_id)
                        if value['status'] in TERMINAL:
                            if value['status']!='succeeded':raise RuntimeError('job '+value['status']+': '+str(value.get('error_code')))
                            return value
                        time.sleep(1)
                    raise RuntimeError('bounded live test exceeded job deadline')
                for _ in range(100):
                    try:
                        if request('GET','/v1/capabilities')[0]==200:break
                    except OSError:time.sleep(.1)
                else:raise RuntimeError('isolated API did not start')
                with urlopen('http://127.0.0.1:5178/api/v1/attachments/'+IMAGE_ID,timeout=30) as response:image=response.read()
                boundary='scorebook'+uuid.uuid4().hex
                body=(f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nquery\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="user-query.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+image+f'\r\n--{boundary}--\r\n'.encode())
                code,value=request('POST','/v1/attachments',body,content_type='multipart/form-data; boundary='+boundary)
                assert code==200,('upload',code)
                attachment=value['data']['id'];del body,image
                before=db.execute('SELECT count(*) FROM chart_search_runs').fetchone()[0]
                for scope in ['private','binance_history']:
                    for period in [None,'','2h']:
                        body={'attachment_id':attachment,'scope':scope}
                        if period is not None:body['interval']=period
                        code,value=request('POST','/v1/chart-search/runs',body)
                        assert code==422 and value['error']['code']==('unsupported_interval' if period=='2h' else 'chart_interval_required')
                assert db.execute('SELECT count(*) FROM chart_search_runs').fetchone()[0]==before
                report['checks'].append('missing/empty/unsupported period rejected before enqueue, both scopes')
                analysis=ok('/v1/chart-analyses',{'attachment_id':attachment})
                report['recognized_interval']=analysis['recognized']['interval']
                report['checks'].append('real local OCR and screenshot geometry executed; search period declared by test')
                ranges=[]
                for symbol in SYMBOLS:
                    for period,seconds in PERIODS.items():
                        now=int(time.time());end=datetime.fromtimestamp(now//seconds*seconds,timezone.utc)
                        start=end-timedelta(seconds=seconds*512)
                        for window in [64,128,256]:
                            value=ok('/v1/history/indexes',{'source':'rest','symbol':symbol,'market':'usd_m','interval':period,'start_at':start.isoformat(),'end_at':end.isoformat(),'window_bars':window,'stride_bars':window//4,'models':['candle-geometry-v2']})
                            wait_job(value['job_id'])
                        ranges.append({'symbol':symbol,'interval':period,'start_at':start.isoformat(),'end_at':end.isoformat()})
                report['checks'].append('12 bounded real Binance history index jobs completed')
                print('Live: 12 bounded real history jobs completed.',flush=True)
                # Exercise an actual lifecycle boundary without downloading an entire lifetime.
                onboard=next(row[2] for row in lifecycle if row[1]=='BTCUSDT')
                first=datetime.fromtimestamp((int(onboard.timestamp())+3599)//3600*3600,timezone.utc)
                end=first+timedelta(hours=128)
                value=ok('/v1/history/plans',{'source':'rest','symbols':['BTCUSDT'],'market':'usd_m','intervals':['1h'],'start_at':(first-timedelta(days=30)).isoformat(),'end_at':end.isoformat(),'window_bars':64,'stride_bars':16,'models':['candle-geometry-v2']})
                wait_job(value['job_id'])
                scope=db.execute('SELECT start_at,end_at,proof FROM history_plan_scopes WHERE plan_id=%s',(value['plan_id'],)).fetchone()
                assert scope and scope[0]==first and scope[1]==end and scope[2]['identity']=='exchange_contract_lifecycle'
                report['checks'].append('actual BTC listing boundary clips pre-listing range; 128 real early 1h bars tested')
                for period,seconds in PERIODS.items():
                    value=ok('/v1/chart-search/runs',{'attachment_id':attachment,'scope':'binance_history','interval':period,'limit':3})
                    wait_job(value['job_id'])
                    result=ok('/v1/chart-search/runs/'+value['search_run_id'])['result']
                    assert result['interval']==period and result['interval_policy']=='same_interval_only', f'{period}: result policy mismatch'
                    items=result['items'];assert items and len(items)<=3, f'{period}: unexpected result count {len(items)}'
                    assert all(item['interval']==period for item in items)
                    assert len({(item['market'],item['symbol']) for item in items})==len(items)
                    for item in items:
                        chart=dict(item['chart_request']);boundary_at=datetime.fromisoformat(chart['end_at'].replace('Z','+00:00'))
                        latest=datetime.fromtimestamp(int(time.time())//seconds*seconds,timezone.utc)
                        chart['match_end_at']=chart['end_at'];chart['end_at']=min(boundary_at+timedelta(seconds=64*seconds),latest).isoformat()
                        code,svg=request('POST','/v1/market/chart',chart,raw=True)
                        assert code==200, f'{period} {item["symbol"]}: chart HTTP {code}'
                        assert '匹配片段'.encode() in svg, f'{period}: missing match boundary'
                        has_following = datetime.fromisoformat(chart['end_at']) > boundary_at
                        expected = '后续走势 · 不参与匹配' if has_following else '尚无后续已收盘 K 线'
                        assert expected.encode() in svg, f'{period}: expected continuation state {expected}'
                        report.setdefault('chart_states',[]).append({'symbol':item['symbol'],'interval':period,'has_closed_followthrough':has_following})
                        del svg
                    report['checks'].append(f'{period}: {len(items)} distinct-contract results, all same-period; live followthrough SVG verified')
                report['published_features']=db.execute("SELECT count(*) FROM public_market.features WHERE published AND model_id='candle-geometry-v2'").fetchone()[0]
                assert report['published_features']<300
                assert db.execute('SELECT count(*) FROM history_subscriptions').fetchone()[0]==0
                report['checks'].append('zero history subscriptions; fewer than 300 temporary features')
                # Persisted result bodies contain locators/scores, no source candle arrays or charts.
                bodies=db.execute('SELECT result::text FROM chart_search_runs WHERE result IS NOT NULL').fetchall()
                assert all('"bars"' not in b[0] and '<svg' not in b[0] for b in bodies)
                report['status']='passed'
        except BaseException as error:
            report['status']='failed';report['failure']=type(error).__name__+': '+str(error);failure=error
        finally:
            for process in reversed(processes):
                process.terminate()
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
            report['isolated_database_deleted']=True
            folder.cleanup()
            report['temporary_directory_deleted']=not base.exists()
            report['completed_at']=datetime.now(timezone.utc).isoformat()
    (ROOT/'docs/period-live-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False),flush=True)
    if failure:raise SystemExit(1)

if __name__=='__main__':main()
