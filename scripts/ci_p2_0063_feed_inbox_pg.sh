#!/usr/bin/env bash
# CI-only isolated PostgreSQL 17 full-schema 0063 proof. No real source access.
set -Eeuo pipefail
[[ "$CI" == true && "$GITHUB_ACTIONS" == true ]] || exit 2
[[ "$GITHUB_REPOSITORY" == "whiteyOnTheMoon/videonews-studio" ]] || exit 2
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]] || exit 2
cd "$(dirname "$0")/.."
container="vns-p204-inbox-ci-$GITHUB_RUN_ID"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --rm --detach --name "$container" \
  --network none --memory 512m --memory-swap 512m \
  --cpus 1 --pids-limit 128 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=256m \
  -e POSTGRES_DB=vns_inbox_ci \
  -e POSTGRES_PASSWORD=ci-only-temporary-postgres-password \
  postgres:17-alpine >/dev/null
sql() {
  docker exec -i "$container" psql -X -w -q -v ON_ERROR_STOP=1 \
    -U postgres -d vns_inbox_ci
}
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$container" psql -X -q -A -t \
    -v ON_ERROR_STOP=1 -U postgres -d vns_inbox_ci \
    -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
    sleep 2
    if docker exec "$container" psql -X -q -A -t \
      -v ON_ERROR_STOP=1 -U postgres -d vns_inbox_ci \
      -c 'SELECT 1' 2>/dev/null | grep -qx 1; then
      ready=true
      break
    fi
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'REFUSED: disposable PostgreSQL unavailable'; exit 2; }
index=0
for file in db/migrations/*.up.sql; do
  index=$((index + 1))
  number=$(printf '%04d' "$index")
  [[ "$(basename "$file")" == "$number"_*.up.sql ]] ||
    { echo 'REFUSED: nonsequential migrations'; exit 2; }
  sql < "$file" >/dev/null
done
[[ "$index" == 63 ]] || { echo 'REFUSED: wrong migration count'; exit 2; }
actual="$(docker exec "$container" psql -X -w -q -A -t \
  -v ON_ERROR_STOP=1 -U postgres -d vns_inbox_ci \
  -c 'SELECT count(*) FROM vns.schema_migrations')"
[[ "$actual" == 63 ]] || { echo 'REFUSED: migration ledger mismatch'; exit 2; }
sql < db/tests/0063_named_feed_inbox.test.sql >/dev/null
sql < db/migrations/0063_named_feed_inbox.down.sql >/dev/null
sql < db/migrations/0063_named_feed_inbox.up.sql >/dev/null
sql < db/tests/0063_named_feed_inbox.test.sql >/dev/null
echo 'PASS: PG17 0001-0063, inbox auth/revocation and 0063 down/up'
