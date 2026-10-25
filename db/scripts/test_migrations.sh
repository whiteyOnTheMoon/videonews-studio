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
  sql < "$root/db/migrations/0006_offline_role_boundaries.up.sql"
  sql < "$root/db/tests/0006_offline_role_boundaries.test.sql"
  sql < "$root/db/migrations/0007_runtime_role_boundaries.up.sql"
  sql < "$root/db/tests/0007_runtime_role_boundaries.test.sql"
  sql < "$root/db/migrations/0008_editor_session_revocation.up.sql"
  sql < "$root/db/tests/0008_editor_session_revocation.test.sql"
  sql < "$root/db/migrations/0009_scoped_editor_review.up.sql"
  sql < "$root/db/tests/0009_scoped_editor_review.test.sql"
  sql < "$root/db/migrations/0010_editor_account_lifecycle_audit.up.sql"
  sql < "$root/db/tests/0010_editor_account_lifecycle_audit.test.sql"
  sql < "$root/db/migrations/0011_operator_registry_governance.up.sql"
  sql < "$root/db/tests/0011_operator_registry_governance.test.sql"
  sql < "$root/db/migrations/0012_runtime_least_privilege.up.sql"
  sql < "$root/db/migrations/0013_synthetic_token_usage.up.sql"
  sql < "$root/db/tests/0013_synthetic_token_usage.test.sql"
  sql < "$root/db/migrations/0014_synthetic_ai_budget_reservations.up.sql"
  sql < "$root/db/tests/0014_synthetic_ai_budget_reservations.test.sql"
  sql < "$root/db/migrations/0015_ai_provider_admin_configuration.up.sql"
  sql < "$root/db/tests/0015_ai_provider_admin_configuration.test.sql"
  sql < "$root/db/migrations/0016_ai_provider_audit_store.up.sql"
  sql < "$root/db/tests/0016_ai_provider_audit_store.test.sql"
  sql < "$root/db/migrations/0017_ai_provider_mutation_admission.up.sql"
  sql < "$root/db/tests/0017_ai_provider_mutation_admission.test.sql"
  if [[ "$iteration" -eq 1 ]]; then
    # Two independent PostgreSQL connections race for the final $0.11
    # of a synthetic $2.00 day. Exactly one $0.09 request can pass.
    sql < "$root/db/tests/0014_synthetic_ai_budget_concurrency.setup.sql"
    work="$(mktemp -d /tmp/vns-budget-ci-XXXXXXXX)"
    docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT vns.reserve_synthetic_ai_budget('e0a11111-1111-4111-8111-111111111111','ci_parallel_req_000001','script_draft','gpt-6.1-sol',20000,5000,DATE '2026-10-28')" > "$work/a" 2>&1 &
    pid_a=$!
    docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT vns.reserve_synthetic_ai_budget('e0a22222-2222-4222-8222-222222222222','ci_parallel_req_000002','script_draft','gpt-6.1-sol',20000,5000,DATE '2026-10-28')" > "$work/b" 2>&1 &
    pid_b=$!
    pass_a=0; pass_b=0
    if wait "$pid_a"; then pass_a=1; fi
    if wait "$pid_b"; then pass_b=1; fi
    test $((pass_a + pass_b)) -eq 1 || {
      echo "FAIL: simultaneous over-budget reservations not serialized" >&2
      rm -rf -- "$work"
      exit 1
    }
    actual="$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT reserved_micro_usd FROM vns.synthetic_ai_budget_days WHERE budget_day=DATE '2026-10-28'")"
    count="$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT count(*) FROM vns.synthetic_ai_reservations WHERE budget_day=DATE '2026-10-28'")"
    test "$actual" = 1980000 && test "$count" = 22 || {
      echo "FAIL: concurrent daily counter mismatch" >&2
      rm -rf -- "$work"
      exit 1
    }
    # A second pair races for one identical ID: one durable row.
    docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT vns.reserve_synthetic_ai_budget('e0a33333-3333-4333-8333-333333333333','ci_parallel_same_000001','script_draft','gpt-6.1-sol',20000,5000,DATE '2026-10-29')" > "$work/c" 2>&1 &
    pid_c=$!
    docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT vns.reserve_synthetic_ai_budget('e0a33333-3333-4333-8333-333333333333','ci_parallel_same_000001','script_draft','gpt-6.1-sol',20000,5000,DATE '2026-10-29')" > "$work/d" 2>&1 &
    pid_d=$!
    wait "$pid_c" && wait "$pid_d"
    test "$(cat "$work/c")" = "$(cat "$work/d")" || {
      echo "FAIL: concurrent repeated reservation identity diverged" >&2
      rm -rf -- "$work"
      exit 1
    }
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT reserved_micro_usd FROM vns.synthetic_ai_budget_days WHERE budget_day=DATE '2026-10-29'")" = 90000
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT count(*) FROM vns.synthetic_ai_reservations WHERE budget_day=DATE '2026-10-29'")" = 1
    rm -rf -- "$work"
    echo "PASS: parallel day cap and idempotent retry"
  fi
  sql < "$root/db/migrations/0017_ai_provider_mutation_admission.down.sql"
  sql < "$root/db/migrations/0016_ai_provider_audit_store.down.sql"
  sql < "$root/db/migrations/0015_ai_provider_admin_configuration.down.sql"
  sql < "$root/db/migrations/0014_synthetic_ai_budget_reservations.down.sql"
  sql < "$root/db/migrations/0013_synthetic_token_usage.down.sql"
  sql < "$root/db/migrations/0012_runtime_least_privilege.down.sql"
  sql < "$root/db/migrations/0011_operator_registry_governance.down.sql"
  sql < "$root/db/migrations/0010_editor_account_lifecycle_audit.down.sql"
  sql < "$root/db/migrations/0009_scoped_editor_review.down.sql"
  sql < "$root/db/migrations/0008_editor_session_revocation.down.sql"
  sql < "$root/db/migrations/0007_runtime_role_boundaries.down.sql"
  sql < "$root/db/migrations/0006_offline_role_boundaries.down.sql"
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
echo "PASS: reversible 0001–0017 migrations, budgets and provider admission twice"
