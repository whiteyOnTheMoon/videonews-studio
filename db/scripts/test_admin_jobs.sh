#!/usr/bin/env bash
# P1-07 CI only: disposable Postgres 17 for auth-protected job creation.
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${CI:-}" != "true" ]]; then
  echo "REFUSED: GitHub Actions only" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="vns-admin-jobs-ci-${GITHUB_RUN_ID:?}"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run --rm -d --name "$name" \
  --network bridge -p 127.0.0.1:15434:5432 \
  --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  -e POSTGRES_USER=vns -e POSTGRES_DB=videonews \
  -e POSTGRES_PASSWORD=ci-outbox-only-not-a-real-password \
  postgres:17-alpine >/dev/null

ready=0
for attempt in $(seq 1 60); do
  if docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
     -U vns -d videonews -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
    sleep 2
    if docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
       -U vns -d videonews -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
       ready=1
       break
    fi
  fi
  sleep 1
done
test "$ready" -eq 1 || { echo "Disposable PostgreSQL not ready" >&2; exit 1; }
for migration in 0001_editorial_core 0002_job_outbox 0003_research_requests; do
  docker exec -i "$name" psql -X -q -v ON_ERROR_STOP=1 -U vns -d videonews \
     < "$root/db/migrations/$migration.up.sql"
done
node "$root/scripts/test_admin_jobs_integration.mjs"
