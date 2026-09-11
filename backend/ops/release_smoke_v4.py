"""Isolated release HTTP smoke. No worker/provider traffic; no credential output."""
import argparse, hashlib, json, os, pathlib, subprocess, tempfile, time, uuid
import urllib.request, urllib.error, urllib.parse
import psycopg
from psycopg import sql

ROOT=pathlib.Path(__file__).resolve().parents[1]
def main():
    p=argparse.ArgumentParser();p.add_argument('--binary',default=str(ROOT/'target/v4-acceptance/release/scorebook'));p.add_argument('--port',type=int,default=18789);a=p.parse_args()
    database='scorebook_v4_smoke_'+uuid.uuid4().hex
    root_url=os.environ['DATABASE_URL'];parts=urllib.parse.urlsplit(root_url)
    test_url=urllib.parse.urlunsplit(parts._replace(path='/'+database))
    server=None
    with psycopg.connect(root_url,autocommit=True) as admin,tempfile.TemporaryDirectory(prefix='scorebook-v4-smoke-') as folder:
        admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
        try:
            env=dict(os.environ,DATABASE_URL=test_url,SCOREBOOK_STORAGE=folder+'/data',SCOREBOOK_BIND='127.0.0.1:'+str(a.port))
            def cli(*args):
                result=subprocess.run([a.binary,*args],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
                if result.returncode:raise RuntimeError('release CLI failed: '+args[0])
                return result.stdout
            cli('migrate');token_file=folder+'/token';cli('create-user','v4-release-smoke','--token-file',token_file)
            token=pathlib.Path(token_file).read_text().strip()
            server=subprocess.Popen([a.binary,'serve'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            observations=[]
            def request(method,path,body=None,key=None,auth=True):
                headers={'Content-Type':'application/json'}
                if auth:headers['Authorization']='Bearer '+token
                if key:headers['Idempotency-Key']=key
                req=urllib.request.Request('http://127.0.0.1:'+str(a.port)+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
                started=time.monotonic()
                try:
                    with urllib.request.urlopen(req,timeout=10) as response: status=response.status;value=json.load(response)
                except urllib.error.HTTPError as e:status=e.code;value=json.loads(e.read())
                observations.append({'method':method,'path':path,'status':status,'ms':round((time.monotonic()-started)*1000,3)})
                return status,value
            for _ in range(100):
                if server.poll() is not None:raise RuntimeError('release server exited')
                try:
                    with urllib.request.urlopen('http://127.0.0.1:'+str(a.port)+'/openapi.json',timeout=1) as r: schema=json.load(r)
                    break
                except (OSError,urllib.error.URLError):time.sleep(.05)
            else:raise RuntimeError('release server did not become ready')
            assert schema['info']['version']=='0.4.0'
            assert request('GET','/v1/capabilities',auth=False)[0]==401
            code,cap=request('GET','/v1/capabilities');assert code==200 and cap['meta']['api_version']=='v1';assert cap['data']['chat_generation']['configured'] is False
            body={'original_text':'发行物 HTTP 隔离验证：等待确认，保留原始判断。'}
            code,saved=request('POST','/v1/calls',body,'record');assert code==200
            assert request('POST','/v1/calls',body,'record')[1]==saved
            record=saved['data']['id'];code,read=request('GET','/v1/calls/'+record);assert code==200 and read['data']['body']['original_text']==body['original_text']
            path='/v1/calls/'+record+'/review-draft'
            code,draft=request('GET',path);assert code==200
            code,_=request('POST',path,{'expected_draft_revision':draft['data']['draft_revision'],'note':'后来复盘独立保存。'},'draft');assert code==200
            code,draft=request('GET',path);assert code==200 and draft['data']['draft']['body']['note']=='后来复盘独立保存。'
            code,_=request('POST','/v1/calls',{'original_text':'invalid','unknown_field':1},'invalid');assert code==422
            code,connection=request('POST','/v1/exchange-connections',{'name':'synthetic','account_label':'fixture','market':'usd_m'},'account');assert code==200
            cid=connection['data']['connection_id']
            fills=[{'trade_id':str(i),'symbol':'BTCUSDT','side':side,'position_side':'BOTH','price':'100','quantity':'1','realized_pnl':'0','settlement_asset':'USDT','commission':'0.1','commission_asset':'USDT','traded_at':'2024-01-01T01:00:00Z'} for i,side in [(1,'BUY'),(2,'SELL')]]
            data={'dataset':'trades','connection_id':cid,'source':'csv','start_at':'2024-01-01T00:00:00Z','end_at':'2024-01-02T00:00:00Z','symbols':['BTCUSDT'],'fills':fills,'declared_complete':False}
            code,receipt=request('POST','/v1/imports',data,'import');assert code==200
            assert request('POST','/v1/imports',data,'import')[1]==receipt
            code,trades=request('GET','/v1/trades?connection_id='+cid);assert code==200 and len(trades['data']['items'])==2
            with psycopg.connect(test_url) as c: version=c.execute('SELECT max(version) FROM _sqlx_migrations').fetchone()[0]
            report={'release_sha256':hashlib.file_digest(open(a.binary,'rb'),'sha256').hexdigest(),'schema_version':version,'isolated_database':True,'live_provider_acceptance':False,'checks':observations,'result':'passed'}
            (ROOT/'docs/release-smoke-v4.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            print(json.dumps({'result':'passed','checks':len(observations),'schema_version':version}))
        finally:
            if server is not None:
                server.terminate()
                try:server.wait(timeout=10)
                except subprocess.TimeoutExpired:server.kill();server.wait(timeout=5)
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(database)))
if __name__=='__main__':main()
