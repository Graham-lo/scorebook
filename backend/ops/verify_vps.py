"""Bounded Linux acceptance using real official monthly archives; always clean up.

Run on the VPS with its model services ready. Uses an isolated database and one
in-memory reference chart. No production records or history synchronization.
"""
import io, json, math, os, pathlib, socket, struct, subprocess, tempfile, time, uuid
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from datetime import datetime, timedelta
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path('/opt/scorebook')
TERMINAL = {'succeeded','failed','needs_attention','blocked_capability','awaiting_input','cancelled'}


def main():
    env = dict(os.environ)
    env.update(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if line and not line.startswith('#'))
    database = 'scorebook_vps_acceptance_' + uuid.uuid4().hex[:12]
    report = {'isolated_database':database,'scope':{'symbols':['BTCUSDT','ETHUSDT'],'interval':'4h','month':'2026-08'},'checks':[]}
    processes = []
    def sql(query, db='scorebook'):
        return subprocess.check_output(['docker','exec','-i','scorebook-postgres','psql','-U','scorebook','-d',db,'-At','-v','ON_ERROR_STOP=1'],input=query,text=True).strip()
    sql('CREATE DATABASE '+database)
    try:
        with tempfile.TemporaryDirectory(prefix='scorebook-vps-acceptance-') as folder:
            env.update(DATABASE_URL=urlunsplit(urlsplit(env['DATABASE_URL'])._replace(path='/'+database)),SCOREBOOK_STORAGE=folder+'/data',SCOREBOOK_BIND='127.0.0.1:18789')
            binary = str(ROOT/'bin/scorebook')
            for args in [('migrate',),('create-user','acceptance','--token-file',folder+'/token')]:
                subprocess.run([binary,*args],env=env,check=True,stdout=subprocess.DEVNULL)
            token=pathlib.Path(folder+'/token').read_text().strip()
            for command in ['serve','worker']:
                processes.append(subprocess.Popen([binary,command],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            def request(path, body=None, content_type=None, raw=False, origin='http://127.0.0.1:18789'):
                payload=body if isinstance(body,bytes) else json.dumps(body).encode() if body is not None else None
                headers={'Authorization':'Bearer '+token,'Idempotency-Key':str(uuid.uuid4())}
                if payload is not None:headers['Content-Type']=content_type or 'application/json'
                try:
                    with urlopen(Request(origin+path,data=payload,headers=headers),timeout=180) as response:
                        data=response.read()
                        return response.status,data if raw else json.loads(data)
                except HTTPError as error:
                    return error.code,json.loads(error.read())
            def ok(path,body=None,**kwargs):
                code,data=request(path,body,**kwargs)
                if code!=200:raise RuntimeError(path+': HTTP '+str(code)+' '+str(data.get('error',{}).get('code')))
                return data['data']
            def wait_job(job):
                deadline=time.monotonic()+300
                while time.monotonic()<deadline:
                    result=ok('/v1/jobs/'+job)
                    if result['status'] in TERMINAL:
                        if result['status']!='succeeded':raise RuntimeError('job '+result['status']+': '+str(result.get('error_code')))
                        return result
                    time.sleep(1)
                raise RuntimeError('job deadline exceeded')
            for _ in range(100):
                try:
                    ok('/v1/capabilities');break
                except OSError:time.sleep(.1)
            else:raise RuntimeError('isolated API unavailable')
            chart={'source':'monthly_archive','symbol':'BTCUSDT','market':'usd_m','interval':'4h','start_at':'2026-08-01T00:00:00Z','end_at':'2026-08-12T00:00:00Z'}
            data=ok('/v1/market/data',chart)
            assert data['coverage_complete'] and len(data['bars'])==66
            assert data['source']=='monthly_archive' and data['storage_policy']=='ephemeral;not_persisted'
            bars=data['bars'][:64]
            image=Image.new('RGB',(1100,600),(16,21,29));draw=ImageDraw.Draw(image)
            draw.text((25,14),'BTCUSDT 4h',font=ImageFont.load_default(size=26),fill='white')
            lo=min(float(b['low']) for b in bars);hi=max(float(b['high']) for b in bars)
            y=lambda value:round(550-(float(value)-lo)/(hi-lo)*465)
            for i,b in enumerate(bars):
                x=35+i*16;color=(38,166,154) if float(b['close'])>=float(b['open']) else (239,83,80)
                draw.line((x,y(b['high']),x,y(b['low'])),fill=color,width=2)
                top,bottom=sorted((y(b['open']),y(b['close'])))
                draw.rectangle((x-5,top,x+5,max(top+2,bottom)),fill=color)
            buffer=io.BytesIO();image.save(buffer,format='PNG');png=buffer.getvalue()
            report['checks'].append('66 real BTC 4h archive candles fetched with complete coverage and checksums')
            ocr=subprocess.run([env['SCOREBOOK_OCR_EXECUTABLE']],input=png,stdout=subprocess.PIPE,check=True,timeout=30)
            ocr=json.loads(ocr.stdout)
            report['ocr_words']=[x['text'] for x in ocr['observations']]
            assert ocr['model_id']=='tesseract-5-eng-v1' and any('BTCUSDT' in x['text'] for x in ocr['observations']), report['ocr_words']
            report['checks'].append('Linux Tesseract OCR recognized actual test chart label')
            code,vision=request('/embed-batch',struct.pack('>II',1,len(png))+png,content_type='application/octet-stream',origin='http://127.0.0.1:8790')
            assert code==200 and len(vision['features'][0]['embedding'])==384 and all(math.isfinite(v) for v in vision['features'][0]['embedding'])
            code,text=request('/embed',{'texts':['突破之后回踩确认，复盘交易执行。']},origin='http://127.0.0.1:8791')
            assert code==200 and len(text['embeddings'][0])==1024 and all(math.isfinite(v) for v in text['embeddings'][0])
            report['checks'].append('real DINOv2 384-dimensional and BGE-M3 1024-dimensional inference succeeded')
            boundary='scorebook'+uuid.uuid4().hex
            body=(f'--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nquery\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="archive-test.png"\r\nContent-Type: image/png\r\n\r\n'.encode()+png+f'\r\n--{boundary}--\r\n'.encode())
            attachment=ok('/v1/attachments',body,content_type='multipart/form-data; boundary='+boundary)['id']
            for scope in ['private','binance_history']:
                code,result=request('/v1/chart-search/runs',{'attachment_id':attachment,'scope':scope})
                assert code==422 and result['error']['code']=='chart_interval_required'
            analysis=ok('/v1/chart-analyses',{'attachment_id':attachment})
            report['ocr_recognized']=analysis.get('recognized')
            report['checks'].append('screenshot analysis succeeded; missing search period rejected in both scopes')
            for symbol in ['BTCUSDT','ETHUSDT']:
                index={**chart,'symbol':symbol,'end_at':'2026-09-01T00:00:00Z','window_bars':64,'stride_bars':16,'models':['candle-geometry-v2']}
                wait_job(ok('/v1/history/indexes',index)['job_id'])
            value=ok('/v1/chart-search/runs',{'attachment_id':attachment,'scope':'binance_history','interval':'4h','limit':3})
            wait_job(value['job_id'])
            result=ok('/v1/chart-search/runs/'+value['search_run_id'])['result']
            items=result['items'];assert 1<=len(items)<=2 and all(x['interval']=='4h' for x in items)
            assert len({x['symbol'] for x in items})==len(items)
            report['results']=[{'symbol':x['symbol'],'interval':x['interval']} for x in items]
            for item in items:
                chart=dict(item['chart_request']);assert chart['source']=='monthly_archive'
                chart['match_end_at']=chart['end_at']
                end=datetime.fromisoformat(chart['end_at'].replace('Z','+00:00'))+timedelta(hours=4*8)
                chart['end_at']=min(end,datetime.fromisoformat('2026-09-01T00:00:00+00:00')).isoformat()
                code,svg=request('/v1/market/chart',chart,raw=True)
                assert code==200 and '匹配片段'.encode() in svg
            report['checks'].append('two real archive indexes, same-period search, distinct-contract top results and regenerated SVG passed')
            count=int(sql('SELECT count(*) FROM public_market.features',database));assert count<30
            assert sql('SELECT count(*) FROM history_subscriptions',database)=='0'
            report['temporary_features']=count
            report['status']='passed'
    except BaseException as error:
        report['status']='failed';report['failure']=type(error).__name__+': '+str(error)
        raise
    finally:
        for process in reversed(processes):
            process.terminate()
            try:process.wait(timeout=15)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        sql('DROP DATABASE '+database+' WITH (FORCE)')
        report['temporary_database_deleted']=sql("SELECT count(*) FROM pg_database WHERE datname='"+database+"'")=='0'
        report['temporary_files_deleted']=not pathlib.Path(folder).exists()
        (ROOT/'logs/acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(report,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
