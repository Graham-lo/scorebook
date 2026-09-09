#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
set -a
. ./.env
set +a
export DATABASE_URL="${DATABASE_URL%/scorebook}/scorebook_test"
cargo test "$@" -- --test-threads=1
