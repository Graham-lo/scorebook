#!/bin/sh
# Consistent logical dump. Pair with an API export for immutable attachments.
set -eu
cd "$(dirname "$0")/.."
output=${1:?usage: backup.sh /absolute/destination.dump}
[ ! -e "$output" ] || { echo 'Refusing to overwrite backup.' >&2; exit 1; }
umask 077
docker compose exec -T postgres pg_dump -U scorebook -d scorebook -Fc > "$output"
echo 'Database dump written. This file alone does not contain attachments.'
