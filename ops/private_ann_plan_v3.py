"""Inspect the actual private retrieval query against a dedicated synthetic corpus."""
import json, os, pathlib, re, sys, time, uuid
import psycopg
ROOT=pathlib.Path(__file__).resolve().parents[1]
name=sys.argv[1];assert name.startswith('scorebook_ann_') and re.fullmatch('[a-z0-9_]+',name)
config=dict(line.split('=',1) for line in (ROOT/'.env').read_text().splitlines() if line and not line.startswith('#'))
url=config['DATABASE_URL'].rsplit('/',1)[0]+'/'+name;o=uuid.uuid4()
with psycopg.connect(url,autocommit=True) as c:
 existing=c.execute("SELECT id FROM users WHERE name='private-ann-fixture' LIMIT 1").fetchone()
 if existing:o=existing[0]
 else:
  c.execute("INSERT INTO users(id,name) VALUES(%s,'private-ann-fixture')",(o,))
  c.execute("INSERT INTO attachments(id,owner_id,sha256,mime,size,width,height,kind) SELECT id,%s,'synthetic-'||id,'image/png',1,640,320,'scene' FROM public_market.features ORDER BY id LIMIT 20000",(o,))
  c.execute("INSERT INTO calls(id,owner_id,body,digest,original_text,instrument,market,timeframe) SELECT id,%s,'{}','synthetic','synthetic retrieval plan','BTCUSDT','usd_m','1h' FROM attachments WHERE owner_id=%s",(o,o))
  c.execute('INSERT INTO call_attachments SELECT owner_id,id,id FROM calls WHERE owner_id=%s',(o,))
 c.execute("INSERT INTO image_embeddings(id,owner_id,attachment_id,model_id,region,region_hash,embedding,quality) SELECT gen_random_uuid(),%s,a.id,'candle-geometry-v2','null','full',f.embedding,'{}' FROM attachments a JOIN public_market.features f ON f.id=a.id WHERE a.owner_id=%s ON CONFLICT DO NOTHING",(o,o))
 for table in ['attachments','calls','call_attachments','image_embeddings']:c.execute('ANALYZE '+table)
 query=re.search(r'r#"(WITH embedding_candidates AS MATERIALIZED .*?LIMIT \$9)"#',(ROOT/'crates/infrastructure/src/application/similarity.rs').read_text(),re.S).group(1).replace('{dimension}','192').replace('{model}','candle-geometry-v2')
 query=re.sub(r'\$(\d+)',lambda m:'%(q'+m[1]+')s',query)
 vector=c.execute('SELECT embedding::text FROM public_market.features ORDER BY id LIMIT 1').fetchone()[0]
 params={'q1':o,'q2':uuid.uuid4(),'q3':'2030-01-01T00:00:00Z','q4':None,'q5':None,'q6':None,'q7':3000,'q8':vector,'q9':20}
 from ann_bench_common import configure
 configure(c)
 plan=c.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+query,params).fetchone()[0]
 approx=c.execute(query,params).fetchall()
 exact=c.execute('SELECT attachment_id FROM image_embeddings WHERE owner_id=%s ORDER BY (embedding::vector(192) <=> %s::vector(192))+0 LIMIT 20',(o,vector)).fetchall()
 # attachment_id is the first returned column in the production projection.
 recall=len({r[0] for r in approx}&{r[0] for r in exact})/len(exact)
 result={'rows':20000,'dimension':192,'scope':'one synthetic tenant, production private join/filter/grouping query','hnsw_selected':'embeddings_structure_hnsw' in json.dumps(plan),'recall_at_20':recall,'plan':plan}
 (ROOT/'docs/private-ann-plan-v3.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({k:v for k,v in result.items() if k!='plan'}))
