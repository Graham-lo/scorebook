"""Run Claude's unchanged frontend integration script against an isolated v4 DB."""
import hashlib, json, os, pathlib, shutil, subprocess, tempfile, time, uuid
from urllib.parse import urlsplit, urlunsplit
import urllib.request
import psycopg
from psycopg import sql

ROOT=pathlib.Path(__file__).resolve().parents[1]
FRONT=ROOT.parent/'scorebook-frontend/app'

def main():
    name='scorebook_frontend_review_'+uuid.uuid4().hex[:12]
    database=os.environ['DATABASE_URL']
    parts=urlsplit(database)
    test_url=urlunsplit(parts._replace(path='/'+name))
    processes=[]
    source_hash=hashlib.file_digest((FRONT/'test/integration.ts').open('rb'),'sha256').hexdigest()
    log=ROOT/'docs/frontend-integration-v4.log'
    with psycopg.connect(database,autocommit=True) as admin, tempfile.TemporaryDirectory(prefix='scorebook-frontend-review-') as folder:
        admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            env=dict(os.environ,DATABASE_URL=test_url,SCOREBOOK_STORAGE=folder+'/data',SCOREBOOK_BIND='127.0.0.1:18789',SCOREBOOK_ALLOWED_ORIGIN='http://127.0.0.1:15178')
            source_binary=os.environ.get('SCOREBOOK_REVIEW_BINARY',str(ROOT/'target/release/scorebook'))
            binary=folder+'/scorebook'
            shutil.copy2(source_binary,binary)
            def cli(*args, timeout=90):
                p=subprocess.run([binary,*args],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
                if p.returncode:raise RuntimeError('CLI failed: '+args[0]+' '+p.stderr.decode()[-1500:])
                return p.stdout
            cli('migrate');cli('create-user','frontend-integration-review','--token-file',folder+'/token')
            cli('refresh-instruments')
            for args in [[binary,'serve'],[binary,'worker'],['node',str(ROOT/'ops/serve-frontend.mjs'),'--dist',str(FRONT/'dist'),'--token-file',folder+'/token','--api','http://127.0.0.1:18789','--port','15178']]:
                processes.append(subprocess.Popen(args,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            for _ in range(100):
                try:
                    with urllib.request.urlopen('http://127.0.0.1:15178/api/v1/capabilities',timeout=1) as r:assert r.status==200
                    break
                except OSError:time.sleep(.1)
            else:raise RuntimeError('isolated frontend did not become ready')
            with log.open('w') as out:
                run=subprocess.run(['npm','run','test:integration'],cwd=FRONT,env=dict(env,SCOREBOOK_PROXY='http://127.0.0.1:15178/api'),stdout=out,stderr=subprocess.STDOUT,timeout=600)
            report={'isolated_database':True,'unmodified_frontend_test_sha256':source_hash,'exit_code':run.returncode,'log':str(log),'binary_sha256':hashlib.file_digest(open(binary,'rb'),'sha256').hexdigest()}
            from diagnose_frontend_review import inspect
            with psycopg.connect(test_url,autocommit=True) as review_db:
                try: report['diagnosis']=inspect(review_db,'http://127.0.0.1:15178/api')
                except Exception as error: report['diagnosis_error']=str(error)
            (ROOT/'docs/frontend-integration-v4.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
            print(json.dumps(report,ensure_ascii=False),flush=True)
            print(log.read_text()[-8000:],flush=True)
            return run.returncode
        finally:
            for p in reversed(processes):
                p.terminate()
                try:p.wait(timeout=15)
                except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))

if __name__=='__main__':raise SystemExit(main())
