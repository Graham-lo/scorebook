"""Live Binance proof stores only test measurements, never raw bars or rendered charts."""
import datetime,hashlib,json,pathlib,time,urllib.request,uuid,xml.etree.ElementTree as ET
ROOT=pathlib.Path(__file__).resolve().parents[1];TOKEN=(ROOT/'data/local-token').read_text().strip();BASE='http://127.0.0.1:8787'
def call(path,body=None):
 headers={'Authorization':'Bearer '+TOKEN}
 if body is not None:headers.update({'Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())})
 r=urllib.request.urlopen(urllib.request.Request(BASE+path,data=json.dumps(body).encode() if body is not None else None,headers=headers),timeout=40)
 payload=r.read()
 if r.headers.get_content_type()=='image/svg+xml':return payload,r.headers.get('Cache-Control')
 return json.loads(payload)['data']
contracts=call('/v1/instruments?q=TSLA');assert any(x['body']['underlyingType']=='EQUITY' for x in contracts['items'])
end=datetime.datetime.now(datetime.timezone.utc).replace(minute=0,second=0,microsecond=0);start=end-datetime.timedelta(hours=96)
q={'symbol':'BTCUSDT','market':'usd_m','interval':'1h','start_at':start.isoformat(),'end_at':end.isoformat()}
started=time.perf_counter();data=call('/v1/market/data',q);fetch_ms=(time.perf_counter()-started)*1000
assert len(data['bars'])==96 and data['storage_policy']=='ephemeral;not_persisted'
svg,cache=call('/v1/market/chart',q);ET.fromstring(svg);assert 'no-store' in cache
job=call('/v1/history/indexes',{**q,'window_bars':64,'stride_bars':16,'models':['candle-geometry-v2','dinov2-small-v1']})
started=time.perf_counter()
for _ in range(120):
 status=call('/v1/jobs/'+job['job_id'])
 if status['status'] in ['failed','succeeded']:break
 time.sleep(1)
assert status['status']=='succeeded',status.get('error_code')
result={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'provider':'binance_usd_m','symbol':'BTCUSDT','timeframe':'1h','requested_hours':96,'bars_received':len(data['bars']),'market_fetch_ms':round(fetch_ms,2),'svg_bytes':len(svg),'svg_valid_xml':True,'cache_control':cache,'historical_index_seconds':round(time.perf_counter()-started,2),'feature_rows':status['result']['feature_rows'],'models':status['result']['models'],'historical_index_id':job['index_id'],'raw_market_storage':'none','chart_storage':'none','quality_claim':'connectivity_and_dataflow_only_not_relevance_accuracy'}
(ROOT/'docs/live-smoke-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
