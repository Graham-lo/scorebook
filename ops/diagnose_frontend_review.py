"""Read-only diagnosis plus isolated re-queries after Claude's integration script."""
import json, time, urllib.request, uuid

def inspect(database, base):
    def api(path, body=None):
        req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Idempotency-Key':str(uuid.uuid4())})
        with urllib.request.urlopen(req,timeout=60) as r:return json.load(r)['data']
    report={}
    run=database.execute('SELECT id FROM set_runs LIMIT 1').fetchone()
    if run:
        members=api('/v1/statistics/runs/'+str(run[0])+'/members')
        report['statistics_members_without_unsupported_limit']={'count':len(members['items']),'http_status':200}
    run=database.execute('SELECT id FROM chat_runs LIMIT 1').fetchone()
    if run:
        chat=api('/v1/chat/runs/'+str(run[0]))
        report['unconfigured_chat_run']={k:chat.get(k) for k in ['status','job_status','model_id','error_code','answer']}
    report['embedding_jobs_before_wait']=database.execute("SELECT status,error_code,count(*) FROM jobs WHERE kind='embed' GROUP BY status,error_code").fetchall()
    for _ in range(90):
        pending=database.execute("SELECT count(*) FROM jobs WHERE kind='embed' AND status IN ('queued','running','retry_wait')").fetchone()[0]
        if not pending:break
        time.sleep(.5)
    row=database.execute("SELECT body,results FROM similarity_sessions WHERE body->>'model_id'='candle-geometry-v2' AND body->'region'='null'::jsonb ORDER BY created_at LIMIT 1").fetchone()
    if row:
        fresh=api('/v1/similarity/search',row[0])
        report['structure_search_after_indexing']={'original_hits':len(row[1]['items']),'after_index_hits':len(fresh['items'])}
    report['embedding_jobs_after_wait']=database.execute("SELECT status,error_code,count(*) FROM jobs WHERE kind='embed' GROUP BY status,error_code").fetchall()
    return report
