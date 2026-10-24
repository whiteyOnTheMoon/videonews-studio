#!/usr/bin/env bash
# Never run on VPS; integration tests are GitHub Actions only.
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true ]]; then
  echo "REFUSED: GitHub Actions runner only" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="vns-p1-05-test-${GITHUB_RUN_ID:?}"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run --rm --detach --name "$name" \
  --network none --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  --env POSTGRES_DB=vns_schema_test \
  --env POSTGRES_PASSWORD=ci-only-not-real \
  postgres:17-alpine >/dev/null

# The official PostgreSQL image briefly starts a temporary server while
# initializing its database. pg_isready may succeed during that phase, then
# fail as the temporary server stops before the final server starts.
# Wait for a real SQL query to work, and require it to stay available.
ready=0
for attempt in $(seq 1 60); do
  if docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c 'SELECT 1' 2>/dev/null | grep -qx '1'; then
    sleep 2
    if docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d vns_schema_test -c 'SELECT 1' 2>/dev/null | grep -qx '1'; then
      ready=1
      break
    fi
  fi
  sleep 1
done
test "$ready" -eq 1 || { echo "Postgres not stably ready"; docker logs "$name" | tail -40; exit 1; }

sql() {
  docker exec -i "$name" psql -X -v ON_ERROR_STOP=1 -U postgres -d vns_schema_test
}
for iteration in 1 2; do
  echo "Migration cycle $iteration"
  sql < "$root/db/migrations/0001_editorial_core.up.sql"
  sql < "$root/db/tests/0001_editorial_core.test.sql"
  sql < "$root/db/migrations/0002_job_outbox.up.sql"
  sql < "$root/db/tests/0002_job_outbox.test.sql"
  sql < "$root/db/migrations/0003_research_requests.up.sql"
  sql < "$root/db/tests/0003_research_requests.test.sql"
  sql < "$root/db/migrations/0004_research_evidence.up.sql"
  sql < "$root/db/tests/0004_research_evidence.test.sql"
  sql < "$root/db/migrations/0005_editorial_review_audit.up.sql"
  sql < "$root/db/tests/0005_editorial_review_audit.test.sql"
  sql < "$root/db/migrations/0005_editorial_review_audit.down.sql"
  sql < "$root/db/migrations/0004_research_evidence.down.sql"
  sql < "$root/db/migrations/0003_research_requests.down.sql"
  sql < "$root/db/migrations/0002_job_outbox.down.sql"
  sql < "$root/db/migrations/0001_editorial_core.down.sql"
  left="$(docker exec "$name" psql -X -A -t -v ON_ERROR_STOP=1 \
    -U postgres -d vns_schema_test \
    -c "SELECT count(*) FROM pg_namespace WHERE nspname='vns'")"
  test "$left" = 0 || { echo "Schema remained after down"; exit 1; }
done
echo "PASS: 0001 + 0002 reversible migration and outbox constraints twice"
