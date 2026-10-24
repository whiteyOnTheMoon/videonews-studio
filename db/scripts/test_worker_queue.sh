#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true ]]; then
  echo "REFUSED: disposable GitHub Actions only" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="vns-worker-test-${GITHUB_RUN_ID:?}"
pg_name="vns-outbox-test-${GITHUB_RUN_ID:?}"
tmp="$(mktemp -d)"
trap 'docker rm -f "$name" "$pg_name" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
python3 "$root/scripts/provision_redis_secrets.py" "$tmp" >/dev/null
docker run --rm -d --name "$name" \
  --network bridge -p 127.0.0.1:16379:6379 \
  --memory 144m --memory-swap 144m --cpus 0.5 --pids-limit 64 \
  --mount "type=bind,src=$tmp/redis_acl,dst=/run/secrets/redis_acl,readonly" \
  redis:7-alpine redis-server --protected-mode yes --bind 0.0.0.0 \
  --aclfile /run/secrets/redis_acl --appendonly no --save "" >/dev/null
for i in $(seq 1 30); do
  if docker exec "$name" redis-cli ping 2>&1 | grep -q NOAUTH; then break; fi
  sleep 1
done
export VNS_TEST_REDIS_PASSWORD_FILE="$tmp/redis_password"
node "$root/scripts/test_worker_integration.mjs"
node "$root/scripts/test_worker_recovery.mjs"

# Run producer/reconciler against another disposable service, not the VPS.
docker run --rm -d --name "$pg_name" \
  --network bridge -p 127.0.0.1:15432:5432 \
  --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  -e POSTGRES_USER=vns -e POSTGRES_DB=videonews \
  -e POSTGRES_PASSWORD=ci-outbox-test-only-not-a-real-secret \
  postgres:17-alpine >/dev/null

pg_ready=0
for i in $(seq 1 60); do
  if docker exec "$pg_name" psql -X -t -A -v ON_ERROR_STOP=1 \
    -U vns -d videonews -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
    sleep 2
    if docker exec "$pg_name" psql -X -t -A -v ON_ERROR_STOP=1 \
      -U vns -d videonews -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
      pg_ready=1
      break
    fi
  fi
  sleep 1
done
test "$pg_ready" = 1 || { echo "CI PostgreSQL unavailable" >&2; exit 1; }
docker exec -i "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -U vns -d videonews \
  < "$root/db/migrations/0001_editorial_core.up.sql"
docker exec -i "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -U vns -d videonews \
  < "$root/db/migrations/0002_job_outbox.up.sql"
docker exec -i "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -U vns -d videonews \
  < "$root/db/migrations/0003_research_requests.up.sql"
docker exec -i "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -U vns -d videonews \
  < "$root/db/migrations/0004_research_evidence.up.sql"
node "$root/scripts/test_outbox_integration.mjs"
node "$root/scripts/test_job_status_integration.mjs"
node "$root/scripts/test_research_process_integration.mjs"
