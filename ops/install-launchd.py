"""Install or refresh this repository's three macOS user services. Does not copy secrets into plists."""
import os, pathlib, plistlib, subprocess, sys
root=pathlib.Path(__file__).resolve().parents[1]
assert sys.platform=='darwin','macOS only'
assert (root/'target/release/scorebook').exists() and (root/'.env').exists()
uid=os.getuid();agents=pathlib.Path.home()/'Library/LaunchAgents';agents.mkdir(parents=True,exist_ok=True)
logs=root/'data/logs';logs.mkdir(parents=True,exist_ok=True);logs.chmod(0o700)
commands={'api':['/bin/sh',str(root/'ops/run.sh'),'serve'],'worker':['/bin/sh',str(root/'ops/run.sh'),'worker'],'vision':[str(root/'vision/.venv/bin/python'),str(root/'vision/server.py')]}
for name,command in commands.items():
    assert pathlib.Path(command[0]).exists(),f'missing runtime for {name}'
    label='dev.scorebook.'+name;path=agents/(label+'.plist')
    config={'Label':label,'ProgramArguments':command,'WorkingDirectory':str(root),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'ExitTimeOut':150,'StandardOutPath':str(logs/(name+'.log')),'StandardErrorPath':str(logs/(name+'.log')),'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}}
    # Own labels only; a fresh installation has nothing to boot out.
    subprocess.run(['launchctl','bootout',f'gui/{uid}/{label}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    path.write_bytes(plistlib.dumps(config));path.chmod(0o600)
    subprocess.run(['launchctl','bootstrap',f'gui/{uid}',str(path)],check=True)
    print(f'Installed {label}')
