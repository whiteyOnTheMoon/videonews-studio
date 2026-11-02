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
sql < "$root/db/independent-anchor/003_trust_policy_admission.sql"
sql < "$root/db/independent-anchor/004_preapproved_trust_policy.sql"
sql < "$root/db/independent-anchor/test_trust_policy.sql"
# Test the EXACT authenticated runtime LOGIN rather than a superuser
# `SET ROLE` session. Privilege introspection must reject unexpectedly
# granted direct DML, even when SELECT remains denied.
sql <<'SQL'
CREATE ROLE vns_anchor_login_ci_worker LOGIN PASSWORD 'synthetic-ci-anchor-login-only';
GRANT USAGE ON SCHEMA vns_source_anchor TO vns_anchor_login_ci_worker;
GRANT EXECUTE ON FUNCTION vns_source_anchor.advance(bigint,bigint,text)
  TO vns_anchor_login_ci_worker;
GRANT EXECUTE ON FUNCTION vns_source_anchor.advance_trust_policy(bigint,text)
  TO vns_anchor_login_ci_worker;
SQL
ci_login() {
  docker exec -i -e PGPASSWORD=synthetic-ci-anchor-login-only "$name" \
    psql -h 127.0.0.1 -X -w -q -v ON_ERROR_STOP=1 \
      -U vns_anchor_login_ci_worker -d anchor_ci "$@"
}
ci_login < "$root/db/independent-anchor/test_runtime_login.sql" >/dev/null
for spec in \
  "UPDATE vns_source_anchor.high_water" \
  "TRUNCATE vns_source_anchor.high_water" \
  "UPDATE vns_source_anchor.trust_policy_high_water" \
  "TRUNCATE vns_source_anchor.trust_policy_approvals"; do
  operation="${spec%% *}"
  table="${spec#* }"
  sql -c "GRANT $operation ON $table TO vns_anchor_login_ci_worker" >/dev/null
  if ci_login < "$root/db/independent-anchor/test_runtime_login.sql" >/dev/null 2>&1; then
    echo "FAIL: external anchor accepted runtime direct table privilege: $operation on $table" >&2
    ci_login -q -t -A -c "SELECT session_user, has_table_privilege(session_user,'$table','$operation')" >&2
    exit 1
  fi
  sql -c "REVOKE $operation ON $table FROM vns_anchor_login_ci_worker" >/dev/null
  ci_login < "$root/db/independent-anchor/test_runtime_login.sql" >/dev/null
done
# An operator-owned, NOINHERIT membership may expose no direct DML before
# SET ROLE; it must still be rejected as a possible bypass of SECURITY DEFINER.
sql -c "GRANT vns_anchor_ci_owner TO vns_anchor_login_ci_worker WITH INHERIT FALSE, SET TRUE" >/dev/null
if ci_login < "$root/db/independent-anchor/test_runtime_login.sql" >/dev/null 2>&1; then
  echo "FAIL: external anchor accepted membership in owner role" >&2
  exit 1
fi
sql -c "REVOKE vns_anchor_ci_owner FROM vns_anchor_login_ci_worker" >/dev/null
ci_login < "$root/db/independent-anchor/test_runtime_login.sql" >/dev/null
echo "PASS: actual PostgreSQL runtime LOGIN denies direct DML and owner-role membership"

# No runtime grant may manipulate the out-of-band trust policy approvals,
# even when directly attempting SQL under SET ROLE.
for statement in \
  "INSERT INTO vns_source_anchor.trust_policy_approvals(policy_revision,policy_sha256) VALUES (4,repeat('f',64))" \
  "UPDATE vns_source_anchor.trust_policy_approvals SET policy_sha256=repeat('f',64)" \
  "DELETE FROM vns_source_anchor.trust_policy_approvals" \
  "SELECT * FROM vns_source_anchor.trust_policy_approvals"; do
  if docker exec "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d anchor_ci \
    -c "SET ROLE vns_trust_ci_worker; $statement" >/dev/null 2>&1; then
    echo "FAIL: worker can read or mutate independent trust approvals" >&2
    exit 1
  fi
done
echo "PASS: independent trust approvals not readable or writable by runtime"

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

# Concurrent trust-policy attempts with one independently preapproved digest.
# An unapproved competing SHA must never be admitted, even at higher revision.
work_trust="$(mktemp -d /tmp/vns-trust-race-XXXXXXXX)"
for pair in "a d" "b e"; do
  read -r label digit <<< "$pair"
  docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 -U postgres -d anchor_ci \
    -c "SET ROLE vns_trust_ci_worker; SELECT vns_source_anchor.advance_trust_policy(3,repeat('$digit',64))" \
    > "$work_trust/$label" 2>&1 &
done
wait
test "$(cat "$work_trust/a" "$work_trust/b" | grep -cx t)" -eq 1
test "$(cat "$work_trust/a" "$work_trust/b" | grep -cx f)" -eq 1
rm -rf "$work_trust"
echo "PASS: trust policy authority concurrent admission"
