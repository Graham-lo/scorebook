"""Create a unique test DB and drop it immediately on completion or interruption."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from urllib.parse import urlsplit, urlunsplit


def main():
    root = Path(__file__).resolve().parents[1]
    config = urlsplit(os.environ['DATABASE_URL'])
    name = 'scorebook_test_' + uuid.uuid4().hex[:12]
    env = dict(os.environ)
    psql = shutil.which('psql')
    if psql:
        # libpq reads the primary URL from an environment variable, never argv.
        admin_env = dict(env, PGDATABASE=os.environ['DATABASE_URL'])
        command = [psql, '--no-psqlrc', '-q', '-v', 'ON_ERROR_STOP=1']
    elif config.hostname in ('127.0.0.1', 'localhost') and config.port == 55432 and config.username == 'scorebook':
        # The repository's explicit local Compose configuration.
        admin_env = env
        command = ['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'scorebook', '-d', 'postgres', '--no-psqlrc', '-q', '-v', 'ON_ERROR_STOP=1']
    else:
        raise SystemExit('Install the PostgreSQL psql client for this configured database host.')

    def admin(statement):
        value = subprocess.run(command, input=statement, text=True, cwd=root, env=admin_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if value.returncode:
            # Do not echo connection URLs or credentials from provider errors.
            raise RuntimeError('Could not create/delete the isolated test database.')

    admin(f'CREATE DATABASE {name};')
    try:
        env['DATABASE_URL'] = urlunsplit(config._replace(path='/' + name))
        result = subprocess.run(['cargo', 'test', '--workspace', *sys.argv[1:], '--', '--test-threads=1'], cwd=root, env=env)
        return result.returncode
    finally:
        admin(f'DROP DATABASE {name} WITH (FORCE);')
        print('Isolated test database deleted.', flush=True)


if __name__ == '__main__':
    raise SystemExit(main())
