"""Install selected macOS services, including the built frontend. Plists contain no secrets."""
import argparse, os, pathlib, plistlib, shutil, subprocess, sys, time
root=pathlib.Path(__file__).resolve().parents[1]
assert sys.platform=='darwin','macOS only'
assert (root/'target/release/scorebook').exists() and (root/'.env').exists()
parser=argparse.ArgumentParser()
parser.add_argument('--services',nargs='+',choices=['api','worker','vision','text','frontend'],default=['api','worker','vision','text','frontend'])
# 两种摆法：开发机上前后端是并排的两棵树，公开仓里是同一棵树下的 backend/ 和 frontend/。
frontend_candidates=[root.parent/'scorebook-frontend/app',root.parent/'frontend/app']
parser.add_argument('--frontend-dir',type=pathlib.Path,default=next((p for p in frontend_candidates if p.is_dir()),frontend_candidates[0]))
parser.add_argument('--lan',action='store_true',help='Share the frontend and its owner account with private LAN devices')
args=parser.parse_args()
uid=os.getuid();agents=pathlib.Path.home()/'Library/LaunchAgents';agents.mkdir(parents=True,exist_ok=True)
logs=root/'data/logs';logs.mkdir(parents=True,exist_ok=True);logs.chmod(0o700)
commands={'api':['/bin/sh',str(root/'ops/run.sh'),'serve'],'worker':['/bin/sh',str(root/'ops/run.sh'),'worker'],'vision':[str(root/'vision/.venv/bin/python'),str(root/'vision/server.py')],'text':[str(root/'vision/.venv/bin/python'),str(root/'text_encoder/server.py')],'frontend':[shutil.which('node') or '/opt/homebrew/bin/node',str(root/'ops/serve-frontend.mjs'),'--dist',str(args.frontend_dir.resolve()/'dist'),'--token-file',str(root/'data/local-token')]}
if 'frontend' in args.services:
    assert (args.frontend_dir/'dist/index.html').exists(),'Build the frontend first: npm run build'
    if args.lan:
        commands['frontend'].append('--lan')
for name in args.services:
    command=commands[name]
    assert pathlib.Path(command[0]).exists(),f'missing runtime for {name}'
    label='dev.scorebook.'+name;path=agents/(label+'.plist')
    config={'Label':label,'ProgramArguments':command,'WorkingDirectory':str(root),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'ExitTimeOut':150,'StandardOutPath':str(logs/(name+'.log')),'StandardErrorPath':str(logs/(name+'.log')),'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2'}}
    # Own labels only; a fresh installation has nothing to boot out.
    subprocess.run(['launchctl','bootout',f'gui/{uid}/{label}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    path.write_bytes(plistlib.dumps(config));path.chmod(0o600)
    # bootout can return while launchd is still removing the old job.
    for attempt in range(30):
        result=subprocess.run(['launchctl','bootstrap',f'gui/{uid}',str(path)],capture_output=True,text=True)
        if result.returncode == 0:
            break
        if attempt == 29:
            sys.stderr.write(result.stderr)
            result.check_returncode()
        time.sleep(0.5)
    print(f'Installed {label}')
