#!/usr/bin/env bash
# Real PostgreSQL 17 + Redis 7, GitHub Actions ONLY. Never run on a VPS.
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true ]]; then
  echo "REFUSED: disposable GitHub Actions job only" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
pg="vns-provider-pg-e2e-${GITHUB_RUN_ID:?}"
redis="vns-provider-redis-e2e-${GITHUB_RUN_ID:?}"
net="vns-provider-net-e2e-${GITHUB_RUN_ID:?}"
cleanup() {
  docker rm -f "$pg" "$redis" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT
pg_password="$(openssl rand -hex 32)"
writer_password="$(openssl rand -hex 32)"
redis_password="$(openssl rand -hex 32)"
docker network create "$net" >/dev/null
docker run -d --rm --name "$pg" --network "$net" \
  -p 127.0.0.1:25432:5432 --memory 512m --cpus 1 --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  -e POSTGRES_DB=vns_provider_ci -e POSTGRES_PASSWORD="$pg_password" \
  postgres:17-alpine >/dev/null
docker run -d --rm --name "$redis" --network "$net" \
  -p 127.0.0.1:26379:6379 --memory 256m --cpus 1 --pids-limit 128 \
  redis:7-alpine redis-server --save "" --appendonly no >/dev/null
sql() {
  docker exec -i "$pg" psql -X -q -v ON_ERROR_STOP=1 \
    -U postgres -d vns_provider_ci
}
ready=0
for i in $(seq 1 60); do
  if echo 'SELECT 1' | sql >/dev/null 2>&1 && \
    docker exec "$redis" redis-cli PING 2>/dev/null | grep -qx PONG; then
    ready=1
    break
  fi
  sleep 2
done
test "$ready" -eq 1 || { echo "FAIL: disposable services not ready"; exit 1; }
for migration in db/migrations/[0-9][0-9][0-9][0-9]_*.up.sql; do
  sql < "$migration" >/dev/null
done
test "$(echo 'SELECT count(*) FROM vns.schema_migrations' | \
  docker exec -i "$pg" psql -X -q -A -t -v ON_ERROR_STOP=1 \
    -U postgres -d vns_provider_ci)" = 48
printf "CREATE ROLE vns_provider_outbox_login LOGIN INHERIT PASSWORD '%s';\nGRANT vns_provider_outbox_reader TO vns_provider_outbox_login;\n" \
  "$writer_password" | sql >/dev/null
docker exec "$redis" redis-cli ACL SETUSER vns_provider_producer reset on \
  ">$redis_password" '~bull:vns:vns-provider-text:*' '+@all' '-@dangerous' '+info' '+acl|whoami' >/dev/null
docker exec "$redis" redis-cli ACL SETUSER default off >/dev/null
VNS_E2E_PG_SUPER_PASSWORD="$pg_password" \
VNS_E2E_PG_PRODUCER_PASSWORD="$writer_password" \
VNS_E2E_REDIS_PRODUCER_PASSWORD="$redis_password" \
node scripts/ci_provider_outbox_real_e2e.mjs
echo "PASS: real isolated PostgreSQL + Redis provider outbox integration"
