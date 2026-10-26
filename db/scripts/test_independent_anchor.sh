#!/usr/bin/env bash
# GitHub Actions disposable isolation only; never target operator PostgreSQL.
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true ]]; then
  echo "REFUSED: CI runner only" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="vns-anchor-ci-${GITHUB_RUN_ID:?}"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$name" --network none --memory 512m --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  -e POSTGRES_PASSWORD=synthetic-ci-only -e POSTGRES_DB=anchor_ci postgres:17-alpine >/dev/null
sql() { docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d anchor_ci; }
ready=0
for _ in $(seq 1 60); do
  if docker exec "$name" psql -X -q -t -A -U postgres -d anchor_ci -c "SELECT 1" 2>/dev/null | grep -qx 1; then
    sleep 2
    if docker exec "$name" psql -X -q -t -A -U postgres -d anchor_ci -c "SELECT 1" 2>/dev/null | grep -qx 1; then ready=1; break; fi
  fi
  sleep 1
done
test "$ready" -eq 1 || { echo "PostgreSQL not ready" >&2; exit 1; }
sql < "$root/db/independent-anchor/001_high_water.sql"
sql < "$root/db/independent-anchor/002_server_admission.sql"
sql < "$root/db/independent-anchor/test_admission.sql"
# Direct DML by worker must fail; not merely return zero rows.
if docker exec "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d anchor_ci \
  -c "SET ROLE vns_anchor_ci_worker; UPDATE vns_source_anchor.high_water SET source_revision=0" >/dev/null 2>&1; then
  echo "FAIL: worker can bypass authority function" >&2
  exit 1
fi
# Competing requests at same revision: only one distinct digest may win.
sql <<'SQL'
SET ROLE vns_anchor_ci_owner;
UPDATE vns_source_anchor.high_water
 SET source_revision=9,host_approval_revision=4,envelope_sha256=repeat('c',64);
RESET ROLE;
SQL
work="$(mktemp -d /tmp/vns-anchor-race-XXXXXXXX)"
trap 'rm -rf "$work"; docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for pair in "a e" "b f"; do
  read -r label digit <<< "$pair"
  docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d anchor_ci \
    -c "SET ROLE vns_anchor_ci_worker; SELECT vns_source_anchor.advance(10,5,repeat('$digit',64))" \
    > "$work/$label" 2>&1 &
done
wait
test "$(cat "$work/a" "$work/b" | grep -cx t)" -eq 1
test "$(cat "$work/a" "$work/b" | grep -cx f)" -eq 1
echo "PASS: independent authority deny, replay and concurrent admission"
