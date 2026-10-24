#!/usr/bin/env bash
# P1-07 disposable full-schema and PostgreSQL GLOBAL ROLE restore drill.
# GitHub Actions ONLY: no exposed ports, host volumes, production hosts or secrets.
set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${CI:-}" != "true" ||
      "${GITHUB_REPOSITORY:-}" != "whiteyOnTheMoon/videonews-studio" ||
      ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]]; then
  echo "REFUSED: trusted GitHub Actions CI runner required" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_name="vns-full-restore-src-${GITHUB_RUN_ID}"
target_name="vns-full-restore-dst-${GITHUB_RUN_ID}"
source_db="vns_full_backup_source"
target_db="vns_full_restore_target"
umask 077
work="$(mktemp -d)"
archive="$work/full-vns.dump"
globals="$work/postgres-globals.sql"

cleanup() {
  docker rm -f "$source_name" "$target_name" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

start_pg() {
  local name="$1" database="$2" user="$3" ready=0
  docker run --rm --detach --name "$name" --network none \
    --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
    --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
    --env POSTGRES_DB="$database" --env POSTGRES_USER="$user" \
    --env POSTGRES_PASSWORD=ci-full-restore-only-not-a-real-secret \
    postgres:17-alpine >/dev/null

  for attempt in $(seq 1 60); do
    if docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U "$user" -d "$database" -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
      sleep 2
      if docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
          -U "$user" -d "$database" -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
        ready=1
        break
      fi
    fi
    sleep 1
  done
  test "$ready" -eq 1 || { echo "FAIL: disposable PostgreSQL not ready" >&2; exit 1; }
}

run_sql() {
  local name="$1" database="$2" user="$3" file="$4"
  docker exec -i "$name" psql -X -q -v ON_ERROR_STOP=1 \
    -U "$user" -d "$database" < "$file"
}

fingerprint() {
  local name="$1" database="$2" user="$3"
  docker exec -i "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
    -U "$user" -d "$database" < "$root/db/tests/full_restore_fingerprint.sql"
}

assert_empty_schema() {
  local state
  state="$(docker exec "$target_name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
    -U restore_admin -d "$target_db" -c \
    "SELECT count(*) FROM pg_namespace WHERE nspname='vns'")"
  test "$state" = 0 || { echo "FAIL: incomplete restore left schema behind" >&2; exit 1; }
}

echo "P1-07: initialize disposable PostgreSQL 17 source with all 11 migrations"
start_pg "$source_name" "$source_db" postgres
for migration in \
  0001_editorial_core 0002_job_outbox 0003_research_requests \
  0004_research_evidence 0005_editorial_review_audit \
  0006_offline_role_boundaries 0007_runtime_role_boundaries \
  0008_editor_session_revocation 0009_scoped_editor_review \
  0010_editor_account_lifecycle_audit 0011_operator_registry_governance
do
  run_sql "$source_name" "$source_db" postgres "$root/db/migrations/$migration.up.sql"
done

run_sql "$source_name" "$source_db" postgres "$root/db/tests/restore_seed.sql"
run_sql "$source_name" "$source_db" postgres "$root/db/tests/full_restore_seed.sql"
run_sql "$source_name" "$source_db" postgres "$root/db/tests/full_restore_verify.sql"
expected="$(fingerprint "$source_name" "$source_db" postgres)"
[[ "$expected" =~ ^[a-f0-9]{32}$ ]] || { echo "FAIL: bad source fingerprint" >&2; exit 1; }

echo "P1-07: capture full vns objects/ACL/owners AND separate global roles/memberships"
docker exec "$source_name" pg_dumpall -U postgres --globals-only \
  --no-role-passwords > "$globals"
docker exec "$source_name" pg_dump -U postgres -d "$source_db" \
  --format=custom --schema=vns > "$archive"
test -s "$globals" && test -s "$archive"
test "$(head -c 5 "$archive")" = PGDMP
docker exec -i "$source_name" pg_restore --list < "$archive" >/dev/null
archive_sha="$(sha256sum "$archive" | cut -d ' ' -f 1)"
globals_sha="$(sha256sum "$globals" | cut -d ' ' -f 1)"

# Detect corrupted/truncated backup bytes WITHOUT allowing them near target.
cp "$archive" "$work/corrupt.dump"
printf 'CI deliberately corrupts this file' >> "$work/corrupt.dump"
if [[ "$(sha256sum "$work/corrupt.dump" | cut -d ' ' -f 1)" = "$archive_sha" ]]; then
  echo "FAIL: corrupted archive passed checksum" >&2
  exit 1
fi
head -c 64 "$archive" > "$work/truncated.dump"
if docker exec -i "$source_name" pg_restore --list \
    < "$work/truncated.dump" >/dev/null 2>&1; then
  echo "FAIL: truncated archive catalog passed validation" >&2
  exit 1
fi
echo "PASS: archive checksums and truncated-catalog detection"

echo "P1-07: initialize independently owned, empty restore destination"
start_pg "$target_name" "$target_db" restore_admin
assert_empty_schema

# Negative test: do NOT suppress role/ACL/owner errors with --no-owner or
# --no-privileges. Without separately restored globals the transaction fails.
if docker exec -i "$target_name" pg_restore -U restore_admin -d "$target_db" \
    --exit-on-error --single-transaction < "$archive" > /dev/null 2>&1; then
  echo "FAIL: missing global roles were silently tolerated" >&2
  exit 1
fi
assert_empty_schema
echo "PASS: missing global roles fail-closed without a partial schema"

test "$(sha256sum "$globals" | cut -d ' ' -f 1)" = "$globals_sha"
# PostgreSQL 17 writes role membership GRANTs with GRANTED BY postgres.
# On a *different* clean cluster, this original grantor lacks the recorded
# ADMIN OPTION for some NOLOGIN roles. PostgreSQL rejects the GRANT even
# when we connect as a separate restore superuser. Reapply the same role
# memberships and option flags as the authenticated bootstrap administrator;
# only grantor provenance changes. Fail closed if any unexpected grantor
# appears. Keep the unmodified originals and their digest as evidence.
grep -q '^CREATE ROLE postgres;' "$globals"
awk '
  /GRANTED BY/ {
    if ($0 !~ /^GRANT .* GRANTED BY postgres;$/) exit 8
    sub(/ GRANTED BY postgres;$/, ";")
    changed++
  }
  { print }
  END { if (changed < 1) exit 9 }
' "$globals" > "$work/globals-replay.sql"
if grep -q 'GRANTED BY ' "$work/globals-replay.sql"; then
  echo "FAIL: unexpected global membership grantor" >&2
  exit 1
fi
run_sql "$target_name" "$target_db" restore_admin "$work/globals-replay.sql"
test "$(sha256sum "$archive" | cut -d ' ' -f 1)" = "$archive_sha"
docker exec -i "$target_name" pg_restore -U restore_admin -d "$target_db" \
  --exit-on-error --single-transaction < "$archive"

run_sql "$target_name" "$target_db" restore_admin \
  "$root/db/tests/full_restore_verify.sql"
restored="$(fingerprint "$target_name" "$target_db" restore_admin)"
test "$expected" = "$restored" || {
  echo "FAIL: source and restored vns table data fingerprints differ" >&2
  exit 1
}
echo "PASS: restored full 0011 schema, all row data, global role grants and definer ownership"

# A second restore into existing application state must reject and preserve it.
if docker exec -i "$target_name" pg_restore -U restore_admin -d "$target_db" \
    --exit-on-error --single-transaction < "$archive" > /dev/null 2>&1; then
  echo "FAIL: unsafe overwrite unexpectedly succeeded" >&2
  exit 1
fi
test "$restored" = "$(fingerprint "$target_name" "$target_db" restore_admin)"
run_sql "$target_name" "$target_db" restore_admin \
  "$root/db/tests/full_restore_verify.sql"
echo "PASS: second restore rejected and previous recovered state unchanged"
echo "PASS: P1-07 full disposable PostgreSQL globals + schema restore rehearsal"
