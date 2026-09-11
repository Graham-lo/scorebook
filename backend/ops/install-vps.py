"""Install a single-user Linux instance, reachable through an SSH tunnel.

Run as root after the locked Linux build and pinned model setup succeed.
Does not import local data, enable history subscriptions, or touch other stacks.
"""
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import time

ROOT = Path('/opt/scorebook')
SOURCE = ROOT / 'source'


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root on the destination VPS.')
    binary = SOURCE / 'target/release/scorebook'
    if not binary.is_file():
        raise SystemExit('Build the Linux release first.')
    try:
        account = pwd.getpwnam('scorebook')
    except KeyError:
        run('useradd', '--system', '--home-dir', str(ROOT), '--shell', '/usr/sbin/nologin', 'scorebook')
        account = pwd.getpwnam('scorebook')
    (ROOT / 'bin').mkdir(exist_ok=True)
    (ROOT / 'data').mkdir(exist_ok=True, mode=0o700)
    os.chmod(ROOT / 'data', 0o700)
    os.chown(ROOT / 'data', account.pw_uid, account.pw_gid)
    staged_binary = ROOT / 'bin/.scorebook-next'
    shutil.copy2(binary, staged_binary)
    os.replace(staged_binary, ROOT / 'bin/scorebook')
    os.chmod(SOURCE / 'native/ocr_linux.py', 0o755)
    ocr = ROOT / 'bin/scorebook-ocr'
    ocr.write_text(f'#!/bin/sh\nexec {ROOT}/venv/bin/python {SOURCE}/native/ocr_linux.py\n')
    os.chmod(ocr, 0o755)
    env_file = ROOT / '.env'
    if not env_file.exists():
        password = secrets.token_hex(32)
        config = {
            'POSTGRES_PASSWORD': password,
            'DATABASE_URL': f'postgres://scorebook:{password}@127.0.0.1:55433/scorebook',
            'SCOREBOOK_STORAGE': str(ROOT / 'data'),
            'SCOREBOOK_BIND': '127.0.0.1:8787',
            'SCOREBOOK_ALLOWED_ORIGIN': 'http://127.0.0.1:5179',
            'SCOREBOOK_EGRESS_ID': 'scorebook-vps-107',
            'SCOREBOOK_BINANCE_WEIGHT_PER_MINUTE': '600',
            'SCOREBOOK_VISION_URL': 'http://127.0.0.1:8790',
            'SCOREBOOK_TEXT_ENCODER_URL': 'http://127.0.0.1:8791',
            'SCOREBOOK_OCR_EXECUTABLE': str(ocr),
            'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
            'OMP_NUM_THREADS': '2', 'TOKENIZERS_PARALLELISM': 'false',
        }
        fd = os.open(env_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(''.join(f'{k}={v}\n' for k, v in config.items()))
    env = dict(os.environ)
    env.update(line.split('=', 1) for line in env_file.read_text().splitlines() if line and not line.startswith('#'))
    (ROOT / 'compose.yaml').write_text('''name: scorebook
services:
  postgres:
    image: pgvector/pgvector:0.8.2-pg17
    container_name: scorebook-postgres
    restart: unless-stopped
    shm_size: 256mb
    mem_limit: 1g
    environment:
      POSTGRES_USER: scorebook
      POSTGRES_DB: scorebook
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
    command: [postgres, -c, shared_buffers=256MB, -c, work_mem=8MB, -c, maintenance_work_mem=128MB, -c, max_connections=80, -c, max_wal_size=1GB]
    ports: ["127.0.0.1:55433:5432"]
    volumes: ["scorebook_pg:/var/lib/postgresql/data"]
    logging:
      driver: json-file
      options: {max-size: 10m, max-file: "3"}
volumes:
  scorebook_pg:
''')
    run('docker', 'compose', 'up', '-d', cwd=ROOT)
    for _ in range(60):
        if subprocess.run(['docker', 'exec', 'scorebook-postgres', 'pg_isready', '-U', 'scorebook'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Scorebook database did not start.')
    executable = str(ROOT / 'bin/scorebook')
    run(executable, 'migrate', env=env)
    token = ROOT / 'data/access-token'
    if not token.exists():
        run(executable, 'create-user', 'owner', '--token-file', str(token), env=env, stdout=subprocess.DEVNULL)
        os.chown(token, account.pw_uid, account.pw_gid)
        os.chmod(token, 0o600)
    components = {
        'api': (f'{executable} serve', '512M'),
        'worker': (f'{executable} worker', '768M'),
        'vision': (f'{ROOT}/venv/bin/python {SOURCE}/vision/server.py', '1G'),
        'text': (f'{ROOT}/venv/bin/python {SOURCE}/text_encoder/server.py', '4G'),
        'frontend': (f'/usr/bin/node {SOURCE}/ops/serve-frontend.mjs --dist {SOURCE}/frontend --token-file {token} --port 5179', '256M'),
    }
    for name, (command, memory) in components.items():
        unit = f'''[Unit]
Description=Scorebook {name}
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=simple
User=scorebook
Group=scorebook
WorkingDirectory={SOURCE}
EnvironmentFile={env_file}
ExecStart={command}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={ROOT}/data
MemoryMax={memory}
CPUQuota=150%
TasksMax=128
UMask=0077
[Install]
WantedBy=multi-user.target
'''
        Path(f'/etc/systemd/system/scorebook-{name}.service').write_text(unit)
    run('systemctl', 'daemon-reload')
    units = [f'scorebook-{name}.service' for name in components]
    run('systemctl', 'enable', *units)
    run('systemctl', 'restart', *units)
    print('Installed Scorebook on VPS loopback port 5179; history synchronization remains off.')


if __name__ == '__main__':
    main()
