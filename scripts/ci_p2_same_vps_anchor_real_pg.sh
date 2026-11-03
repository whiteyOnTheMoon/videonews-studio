#!/usr/bin/env bash
# Disposable PostgreSQL 17 acceptance only; NEVER points at production.
set -Eeuo pipefail
if [[ "$GITHUB_ACTIONS" != "true" || "$CI" != "true" || -z "$GITHUB_RUN_ID" ]]; then
  echo "REFUSED: disposable GitHub CI only" >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
name="vns-one-vps-anchor-ci-$GITHUB_RUN_ID"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name "$name" --network none --memory 512m --cpus 1 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  -e POSTGRES_USER=vns -e POSTGRES_PASSWORD=synthetic-ci-only \
  -e POSTGRES_DB=videonews postgres:17-alpine >/dev/null
sql() {
  docker exec -i "$name" psql -X -w -q -A -t -v ON_ERROR_STOP=1 \
    -U vns -d videonews "$@"
}
ready=0
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -q -U vns -d videonews 2>/dev/null; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" -eq 1 ]] || { echo "REFUSED: disposable PostgreSQL not ready"; exit 2; }
# Synthetic *application-shaped* tables; no real editor, publisher or feed.
sql <<'SQL'
CREATE SCHEMA vns;
CREATE TABLE vns.schema_migrations(version text PRIMARY KEY);
INSERT INTO vns.schema_migrations
 SELECT lpad(n::text,4,'0') || '_synthetic'
   FROM generate_series(1,60) n;
INSERT INTO vns.schema_migrations VALUES ('0061_single_owner_review_policy');
CREATE TABLE vns.admin_source_registry(
 singleton boolean PRIMARY KEY, revision bigint NOT NULL, sources jsonb NOT NULL);
CREATE TABLE vns.admin_source_host_approvals(
 singleton boolean PRIMARY KEY, revision bigint NOT NULL, approved_hosts jsonb NOT NULL);
CREATE TABLE vns.admin_source_audit(id integer PRIMARY KEY);
CREATE TABLE vns.admin_source_host_audit(id integer PRIMARY KEY);
CREATE TABLE vns.feed_event_rankings(approved_for_publication boolean);
CREATE TABLE vns.single_owner_review_policy(
 singleton boolean PRIMARY KEY, enabled boolean NOT NULL);
INSERT INTO vns.admin_source_registry VALUES
 (true,8,'[{"id":"a","status":"approved"},{"id":"b","status":"approved"},{"id":"c","status":"approved"}]');
INSERT INTO vns.admin_source_host_approvals VALUES
 (true,7,'["a.example.org","b.example.org","c.example.org"]');
INSERT INTO vns.admin_source_audit SELECT generate_series(1,8);
INSERT INTO vns.admin_source_host_audit SELECT generate_series(1,7);
INSERT INTO vns.single_owner_review_policy VALUES (true,true);
SQL
# Exercise the exact generated DDL with a SYNTHETIC SCRAM verifier.
PYTHONPATH=scripts python3 - <<'PY' | sql >/dev/null
import argparse
import p2_01_same_vps_anchor as a
from provision_pg_runtime_logins import scram_verifier
candidate = argparse.Namespace(source_revision=8, host_revision=7,
    envelope_sha256="b"*64, policy_revision=1, policy_sha256="c"*64)
print(a.installation_sql(candidate, scram_verifier("S"*64, b"x"*16)))
PY
verified() {
  PYTHONPATH=scripts python3 - <<'PY' | sql
import argparse
import p2_01_same_vps_anchor as a
print(a.verify_sql(argparse.Namespace(source_revision=8, host_revision=7,
    envelope_sha256="b"*64, policy_revision=1, policy_sha256="c"*64)))
PY
}
[[ "$(verified)" == "t" ]] || {
  echo "FAIL: installed same-VPS authority was not attested" >&2
  exit 1
}
login_query="SELECT session_user='vns_anchor_login_prod'
 AND has_function_privilege(session_user,
   'vns_source_anchor.advance(bigint,bigint,text)','EXECUTE')
 AND NOT has_schema_privilege(session_user,'vns','USAGE')
 AND NOT has_table_privilege(session_user,
   'vns_source_anchor.high_water','SELECT,UPDATE');"
actual="$(docker exec -e PGPASSWORD="$(printf 'S%.0s' {1..64})" "$name" \
  psql -h 127.0.0.1 -X -w -q -A -t -v ON_ERROR_STOP=1 \
    -U vns_anchor_login_prod -d videonews -c "$login_query")"
[[ "$actual" == "t" ]] || { echo "FAIL: actual SCRAM anchor login rejected"; exit 1; }
echo "PASS: actual constrained SCRAM login on disposable shared PostgreSQL"
sql <<< 'GRANT UPDATE ON vns_source_anchor.high_water TO vns_anchor_login_prod;' >/dev/null
[[ "$(verified)" == "f" ]] || { echo "FAIL: direct UPDATE not detected"; exit 1; }
sql <<< 'REVOKE UPDATE ON vns_source_anchor.high_water FROM vns_anchor_login_prod;' >/dev/null
sql <<< 'GRANT vns_source_anchor_owner TO vns_anchor_login_prod WITH INHERIT FALSE, SET TRUE;' >/dev/null
[[ "$(verified)" == "f" ]] || { echo "FAIL: owner membership not detected"; exit 1; }
sql <<< 'REVOKE vns_source_anchor_owner FROM vns_anchor_login_prod;' >/dev/null
[[ "$(verified)" == "t" ]] || { echo "FAIL: restored clean role rejected"; exit 1; }
[[ "$(sql <<< "SELECT vns_source_anchor.advance_trust_policy(1,repeat('d',64));")" == "f" ]] ||
  { echo "FAIL: unapproved signer digest admitted"; exit 1; }
[[ "$(sql <<< "SELECT vns_source_anchor.advance(7,7,repeat('b',64));")" == "f" ]] ||
  { echo "FAIL: stale signed sources admitted"; exit 1; }
[[ "$(verified)" == "t" ]] || { echo "FAIL: authority state mutated"; exit 1; }
echo "PASS: shared-VPS bootstrap, verify, denial and state preservation"
