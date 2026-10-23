#!/usr/bin/env bash
# Disposable PostgreSQL logical backup + restore drill (CI ONLY).
# Never connect to a VPS, mount a host data volume, or publish container ports.
set -Eeuo pipefail

if [[ "$GITHUB_ACTIONS" != "true" || "$CI" != "true" || -z "$GITHUB_RUN_ID" ]]; then
  echo "REFUSED: GitHub Actions only" >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
source_name="vns-restore-src-$GITHUB_RUN_ID"
target_name="vns-restore-dst-$GITHUB_RUN_ID"
source_db="vns_ci_backup_source"
target_db="vns_ci_restore_target"
umask 077
work="$(mktemp -d)"
archive="$work/vns-test.dump"

cleanup() {
  docker rm -f "$source_name" "$target_name" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

start_disposable_pg() {
  local name="$1" database="$2" ready=0
  docker run --rm --detach --name "$name" \
    --network none \
    --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
    --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
    --env POSTGRES_DB="$database" \
    --env POSTGRES_PASSWORD=ci-only-ephemeral-not-real \
    postgres:17-alpine >/dev/null

  # Wait for stable SQL availability, not the temporary init server.
  for attempt in $(seq 1 60); do
    if docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d "$database" -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
      sleep 2
      if docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d "$database" -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
        ready=1
        break
      fi
    fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    echo "FAIL: disposable PostgreSQL not ready" >&2
    exit 1
  fi
}

run_sql() {
  local name="$1" database="$2" path="$3"
  docker exec -i "$name" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$database" < "$path"
}

echo "P1-07: initialize source database on isolated tmpfs"
start_disposable_pg "$source_name" "$source_db"
run_sql "$source_name" "$source_db" "$root/db/migrations/0001_editorial_core.up.sql"
run_sql "$source_name" "$source_db" "$root/db/tests/restore_seed.sql"
run_sql "$source_name" "$source_db" "$root/db/tests/restore_verify.sql"

echo "P1-07: export custom-format schema+data archive"
docker exec "$source_name" pg_dump -U postgres -d "$source_db" \
  --format=custom --schema=vns --no-owner --no-privileges > "$archive"
test -s "$archive"
test "$(head -c 5 "$archive")" = PGDMP
docker exec -i "$source_name" pg_restore --list < "$archive" > /dev/null
before="$(sha256sum "$archive" | cut -d ' ' -f 1)"
echo "PASS: custom-format archive created and catalog readable"

echo "P1-07: initialize independent clean restore target"
start_disposable_pg "$target_name" "$target_db"
initial="$(docker exec "$target_name" psql -X -t -A -U postgres -d "$target_db" -c "SELECT count(*) FROM pg_namespace WHERE nspname='vns'")"
test "$initial" = 0

# Restore without --clean; any error aborts the entire transaction.
docker exec -i "$target_name" pg_restore -U postgres -d "$target_db" \
  --exit-on-error --single-transaction --no-owner --no-privileges < "$archive"

after="$(sha256sum "$archive" | cut -d ' ' -f 1)"
test "$before" = "$after"
run_sql "$target_name" "$target_db" "$root/db/tests/restore_verify.sql"
echo "PASS: restored data, relationships, schema ledger, triggers and constraints"

# Fail-closed: restoring over existing schema must fail, never silently replace it.
if docker exec -i "$target_name" pg_restore -U postgres -d "$target_db" \
  --exit-on-error --single-transaction --no-owner --no-privileges \
  < "$archive" > /dev/null 2>&1; then
  echo "FAIL: restoring over existing schema unexpectedly succeeded" >&2
  exit 1
fi
run_sql "$target_name" "$target_db" "$root/db/tests/restore_verify.sql"
echo "PASS: unsafe second restore rejected; original restored data remains intact"
echo "PASS: P1-07 disposable PostgreSQL backup/restore drill"
