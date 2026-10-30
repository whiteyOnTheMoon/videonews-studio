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
  sql < "$root/db/migrations/0018_ai_provider_named_audit.up.sql"
  sql < "$root/db/tests/0018_ai_provider_named_audit.test.sql"
  sql < "$root/db/migrations/0019_feed_poll_contract.up.sql"
  sql < "$root/db/tests/0019_feed_poll_contract.test.sql"
  if [[ "$iteration" -eq 1 ]]; then
    # Two independent SQL sessions compete for one feed lease.
    feed_work="$(mktemp -d /tmp/vns-feed-ci-XXXXXXXX)"
    for label in a b; do
      docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d vns_schema_test -c \
        "SET ROLE vns_feed_poll_writer; SELECT count(*) FROM vns.claim_feed_poll('ci_parallel_feed',60)" \
        > "$feed_work/$label" 2>&1 &
      if [[ "$label" = a ]]; then feed_pid_a=$!; else feed_pid_b=$!; fi
    done
    wait "$feed_pid_a" && wait "$feed_pid_b"
    test "$(cat "$feed_work/a" "$feed_work/b" | grep -cx 1)" = 1 &&
    test "$(cat "$feed_work/a" "$feed_work/b" | grep -cx 0)" = 1 || {
      echo "FAIL: concurrent feed claims bypassed one-slot admission" >&2
      rm -rf -- "$feed_work"
      exit 1
    }
    rm -rf -- "$feed_work"
    echo "PASS: concurrent feed claim selects only one writer"
  fi
  sql < "$root/db/migrations/0020_source_admin_registry.up.sql"
  sql < "$root/db/tests/0020_source_admin_registry.test.sql"
  sql < "$root/db/migrations/0021_source_transition_guard.up.sql"
  sql < "$root/db/tests/0021_source_transition_guard.test.sql"
  sql < "$root/db/migrations/0022_independent_host_approval.up.sql"
  sql < "$root/db/tests/0022_independent_host_approval.test.sql"
  sql < "$root/db/tests/0023_source_host_role_separation.test.sql"
  sql < "$root/db/migrations/0023_two_person_host_grants.up.sql"
  sql < "$root/db/tests/0023_two_person_host_grants.test.sql"
  sql < "$root/db/migrations/0024_editorial_timeline.up.sql"
  sql < "$root/db/tests/0024_editorial_timeline.test.sql"
  sql < "$root/db/migrations/0025_editorial_timeline_contract.up.sql"
  sql < "$root/db/tests/0025_editorial_timeline_contract.test.sql"
  sql < "$root/db/migrations/0026_editorial_research_persistence.up.sql"
  sql < "$root/db/tests/0026_editorial_research_persistence.test.sql"
  sql < "$root/db/migrations/0027_editorial_profiles.up.sql"
  sql < "$root/db/tests/0027_editorial_profiles.test.sql"
  sql < "$root/db/migrations/0028_feed_candidate_projection.up.sql"
  sql < "$root/db/tests/0028_feed_candidate_projection.test.sql"
  sql < "$root/db/migrations/0029_named_editor_db_gateway.up.sql"
  sql < "$root/db/tests/0029_named_editor_db_gateway.test.sql"
  sql < "$root/db/migrations/0030_editorial_checkpoints.up.sql"
  sql < "$root/db/tests/0030_editorial_checkpoints.test.sql"
  sql < "$root/db/migrations/0031_personal_editor_exports.up.sql"
  sql < "$root/db/tests/0031_personal_editor_exports.test.sql"
  sql < "$root/db/migrations/0032_feed_runtime_source_authorization.up.sql"
  sql < "$root/db/tests/0032_feed_runtime_source_authorization.test.sql"
  sql < "$root/db/migrations/0033_guarded_feed_commit.up.sql"
  sql < "$root/db/tests/0033_guarded_feed_commit.test.sql"
  sql < "$root/db/migrations/0034_atomic_source_export_authority.up.sql"
  sql < "$root/db/tests/0034_atomic_source_export_authority.test.sql"
  sql < "$root/db/migrations/0035_approved_feed_candidate_projection.up.sql"
  sql < "$root/db/tests/0035_approved_feed_candidate_projection.test.sql"
  sql < "$root/db/migrations/0036_provider_usage_evidence.up.sql"
  sql < "$root/db/tests/0036_provider_usage_evidence.test.sql"
  sql < "$root/db/migrations/0037_provider_live_budget_ledger.up.sql"
  sql < "$root/db/tests/0037_provider_live_budget_ledger.test.sql"
  sql < "$root/db/migrations/0038_provider_worker_budget_guard.up.sql"
  sql < "$root/db/tests/0038_provider_worker_budget_guard.test.sql"
  sql < "$root/db/migrations/0039_provider_one_shot_dispatch_claim.up.sql"
  sql < "$root/db/tests/0039_provider_one_shot_dispatch_claim.test.sql"
  sql < "$root/db/migrations/0040_provider_offline_eur_fx_guard.up.sql"
  sql < "$root/db/tests/0040_provider_offline_eur_fx_guard.test.sql"
  sql < "$root/db/migrations/0041_named_live_price_fx_reviews.up.sql"
  sql < "$root/db/tests/0041_named_live_price_fx_reviews.test.sql"
  sql < "$root/db/migrations/0042_provider_reviewed_model_selection.up.sql"
  sql < "$root/db/tests/0042_provider_reviewed_model_selection.test.sql"
  sql < "$root/db/migrations/0043_claimed_provider_secret_scope.up.sql"
  sql < "$root/db/tests/0043_claimed_provider_secret_scope.test.sql"
  sql < "$root/db/tests/0043_provider_worker_logins.test.sql"
  sql < "$root/db/migrations/0044_named_provider_job_authorization.up.sql"
  sql < "$root/db/tests/0044_named_provider_job_authorization.test.sql"
  if [[ "$iteration" -eq 1 ]]; then
    # Two independent SQL sessions compete for five shared admission slots.
    admission_work="$(mktemp -d /tmp/vns-admission-ci-XXXXXXXX)"
    for label in a b; do
      docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d vns_schema_test -c \
        "SET ROLE vns_provider_config_writer; SELECT vns.admin_try_ai_provider_mutation_slot() FROM generate_series(1,4)" \
        > "$admission_work/$label" 2>&1 &
      if [[ "$label" = a ]]; then admission_pid_a=$!; else admission_pid_b=$!; fi
    done
    wait "$admission_pid_a" && wait "$admission_pid_b"
    admission_allowed="$(cat "$admission_work/a" "$admission_work/b" | grep -c "^t")"
    admission_denied="$(cat "$admission_work/a" "$admission_work/b" | grep -c "^f")"
    test "$admission_allowed" = 5 && test "$admission_denied" = 3 || {
      echo "FAIL: cross-session provider admission quota was bypassed" >&2
      rm -rf -- "$admission_work"
      exit 1
    }
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      "SELECT attempts FROM vns.ai_provider_mutation_window WHERE singleton=true")" = 5 || {
      echo "FAIL: provider admission counter not durable" >&2
      rm -rf -- "$admission_work"
      exit 1
    }
    rm -rf -- "$admission_work"
    echo "PASS: two independent SQL sessions share five admission slots"
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
  if [[ "$iteration" -eq 1 ]]; then
    # A real cross-session source-admin revision race (not just a mocked adapter).
    sql < "$root/db/tests/0020_source_admin_concurrency.setup.sql"
    source_work="$(mktemp -d /tmp/vns-source-ci-XXXXXXXX)"
    source_payload='[{"id":"ci_parallel_source","baseUrl":"https://example.org/parallel/","access":"rss","intervalMinutes":60,"termsUrl":"https://example.org/terms/","usage":"metadata_only","licenseNotes":"Synthetic race fixture only.","status":"pending","reviewedAt":"2026-10-26"}]'
    for label in a b; do
      docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d vns_schema_test -c \
        "SET ROLE vns_source_admin_writer; SELECT vns.admin_commit_source_registry(0,1,\$\$${source_payload}\$\$::jsonb,'ci_parallel_source','create_pending','ca110003-3333-4333-8333-333333333333'::uuid,0,'2026-10-26T12:00:00Z');" \
        > "$source_work/$label" 2>&1 &
      if [[ "$label" = a ]]; then source_pid_a=$!; else source_pid_b=$!; fi
    done
    wait "$source_pid_a" && wait "$source_pid_b"
    test "$(grep -cx 't' "$source_work/a" "$source_work/b" | awk -F: '{s+=$2} END {print s+0}')" = 1
    test "$(grep -cx 'f' "$source_work/a" "$source_work/b" | awk -F: '{s+=$2} END {print s+0}')" = 1
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c "SELECT revision FROM vns.admin_source_registry WHERE singleton")" = 1
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c "SELECT count(*) FROM vns.admin_source_audit WHERE revision=1 AND editor_username='ci_source_racer'")" = 1
    rm -rf -- "$source_work"
    echo "PASS: two independent source-admin sessions commit exactly one revision and audit"
  fi
  if [[ "$iteration" -eq 1 ]]; then
    # Two independent PostgreSQL sessions must never grant a host twice.
    sql < "$root/db/tests/0022_independent_host_concurrency.setup.sql"
    host_work="$(mktemp -d /tmp/vns-host-ci-XXXXXXXX)"
    for label in a b; do
      docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d vns_schema_test -c \
        "SET ROLE vns_host_approval_writer; SELECT vns.admin_change_source_host_approval(0,3,'grant','race.example.org','Synthetic independently reviewed limited metadata rights.','ca220003-3333-4333-8333-333333333333'::uuid,0);" \
        > "$host_work/$label" 2>&1 &
      if [[ "$label" = a ]]; then host_pid_a=$!; else host_pid_b=$!; fi
    done
    wait "$host_pid_a" && wait "$host_pid_b"
    test "$(cat "$host_work/a" "$host_work/b" | grep -cx 't')" = 1
    test "$(cat "$host_work/a" "$host_work/b" | grep -cx 'f')" = 1
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c "SELECT revision FROM vns.admin_source_host_approvals WHERE singleton")" = 1
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c "SELECT count(*) FROM vns.admin_source_host_audit WHERE revision=1 AND editor_username='ci_host_racer'")" = 1
    rm -rf -- "$host_work"
    echo "PASS: two independent host-approval sessions persist one grant and audit"
  fi
  if [[ "$iteration" -eq 1 ]]; then
    # Two independent SQL connections race for a single $0.0003 reservation.
    sql < "$root/db/tests/0037_provider_live_budget_concurrency.setup.sql"
    live_work="$(mktemp -d /tmp/vns-live-budget-ci-XXXXXXXX)"
    for label in a b; do
      if [[ "$label" = a ]]; then
        job="b3710001-1111-4111-8111-111111111111"
      else
        job="b3710002-2222-4222-8222-222222222222"
      fi
      docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d vns_schema_test -c \
        "SET ROLE vns_provider_usage_writer;
         SELECT vns.reserve_provider_live_budget(
         '$job','openai','ci-parallel-model','ci_parallel_request_0001',
         'b3710000-0000-4000-8000-000000000001',100,100)" \
         > "$live_work/$label" 2>&1 &
      if [[ "$label" = a ]]; then live_pid_a=$!; else live_pid_b=$!; fi
    done
    live_pass_a=0
    live_pass_b=0
    if wait "$live_pid_a"; then live_pass_a=1; fi
    if wait "$live_pid_b"; then live_pass_b=1; fi
    test $((live_pass_a + live_pass_b)) -eq 1 || {
      echo "FAIL: two concurrent real-budget reservations exceeded cap" >&2
      rm -rf -- "$live_work"
      exit 1
    }
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      'SELECT count(*) FROM vns.provider_live_reservations')" = 1
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      'SELECT sum(reserved_micro_usd) FROM vns.provider_live_reservations')" = 300
    rm -rf -- "$live_work"
    echo "PASS: two independent SQL sessions admit exactly one $0.0003 reservation"
  fi
  if [[ "$iteration" -eq 1 ]]; then
    # Real SQL sessions compete for exactly one irreversible claim.
    sql < "$root/db/tests/0039_provider_dispatch_claim_concurrency.setup.sql"
    claim_work="$(mktemp -d /tmp/vns-provider-claim-ci-XXXXXXXX)"
    for label in a b; do
      docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d vns_schema_test -c \
        "SET ROLE vns_provider_usage_writer;
         SELECT coalesce(vns.claim_provider_live_dispatch(
           'a3910003-0000-4000-8000-000000000003')::text,'denied')" \
        > "$claim_work/$label" 2>&1 &
      if [[ "$label" = a ]]; then claim_pid_a=$!; else claim_pid_b=$!; fi
    done
    wait "$claim_pid_a" && wait "$claim_pid_b"
    claim_denied="$(cat "$claim_work/a" "$claim_work/b" | grep -cx 'denied' || true)"
    claim_issued="$(cat "$claim_work/a" "$claim_work/b" |
      grep -Ec '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' || true)"
    test "$claim_denied" = 1 && test "$claim_issued" = 1 || {
      echo "FAIL: two-session one-shot dispatch was not unique" >&2
      rm -rf -- "$claim_work"
      exit 1
    }
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      'SELECT count(*) FROM vns.provider_live_dispatch_claims')" = 1 || {
      echo "FAIL: more than one dispatch claim persisted" >&2
      rm -rf -- "$claim_work"
      exit 1
    }
    rm -rf -- "$claim_work"
    echo "PASS: two independent SQL sessions issue exactly one provider dispatch claim"
  fi
  if [[ "$iteration" -eq 1 ]]; then
    # Independent PostgreSQL sessions compete for exactly one EUR cap slot;
    # the USD cap admits both, so only the EUR gate can reject the second.
    sql < "$root/db/tests/0040_provider_eur_concurrency.setup.sql"
    eur_before_count="$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      'SELECT count(*) FROM vns.provider_live_eur_admissions')"
    eur_before_sum="$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      'SELECT coalesce(sum(reserved_micro_eur),0) FROM vns.provider_live_eur_admissions')"
    eur_work="$(mktemp -d /tmp/vns-eur-budget-ci-XXXXXXXX)"
    for label in a b; do
      if [[ "$label" = a ]]; then
        job="a4010001-1111-4111-8111-111111111111"
      else
        job="a4010002-2222-4222-8222-222222222222"
      fi
      docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
        -U postgres -d vns_schema_test -c \
        "SET ROLE vns_provider_usage_writer;
         SELECT vns.reserve_provider_live_budget(
           '$job','openai','ci-eur-race-model','ci_eur_race_req_0001',
           'a4010000-0000-4000-8000-000000000001',100,100)" \
         > "$eur_work/$label" 2>&1 &
      if [[ "$label" = a ]]; then eur_pid_a=$!; else eur_pid_b=$!; fi
    done
    eur_ok_a=0
    eur_ok_b=0
    if wait "$eur_pid_a"; then eur_ok_a=1; fi
    if wait "$eur_pid_b"; then eur_ok_b=1; fi
    test $((eur_ok_a + eur_ok_b)) -eq 1 || {
      echo "FAIL: simultaneous EUR cap admission race" >&2
      cat "$eur_work/a" "$eur_work/b" >&2
      rm -rf -- "$eur_work"
      exit 1
    }
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      'SELECT count(*) FROM vns.provider_live_eur_admissions')" = "$((eur_before_count + 1))"
    test "$(docker exec "$name" psql -X -q -t -A -v ON_ERROR_STOP=1 \
      -U postgres -d vns_schema_test -c \
      'SELECT sum(reserved_micro_eur) FROM vns.provider_live_eur_admissions')" = "$((eur_before_sum + 300))"
    rm -rf -- "$eur_work"
    echo "PASS: independent SQL sessions cannot exceed 300 micro-EUR"
  fi
  sql < "$root/db/migrations/0045_atomic_named_provider_budget_gate.up.sql"
  sql < "$root/db/tests/0045_atomic_named_provider_budget_gate.test.sql"
  sql < "$root/db/migrations/0046_provider_named_sealed_outbox.up.sql"
  sql < "$root/db/tests/0046_provider_named_sealed_outbox.test.sql"
  sql < "$root/db/migrations/0047_named_provider_job_submission.up.sql"
  sql < "$root/db/tests/0047_named_provider_job_submission.test.sql"
  sql < "$root/db/migrations/0048_provider_outbox_delivery_receipt.up.sql"
  sql < "$root/db/tests/0048_provider_outbox_delivery_receipt.test.sql"
  sql < "$root/db/migrations/0049_approved_feed_rankings.up.sql"
  sql < "$root/db/tests/0049_approved_feed_rankings.test.sql"
  sql < "$root/db/migrations/0050_reviewed_feed_endpoints.up.sql"
  sql < "$root/db/tests/0050_reviewed_feed_endpoints.test.sql"
  sql < "$root/db/migrations/0051_rank_unicode_freshness.up.sql"
  sql < "$root/db/tests/0051_rank_unicode_freshness.test.sql"
  sql < "$root/db/migrations/0052_rewritten_syndication.up.sql"
  sql < "$root/db/tests/0052_rewritten_syndication.test.sql"
  sql < "$root/db/migrations/0053_reviewed_weighted_rankings.up.sql"
  sql < "$root/db/tests/0053_reviewed_weighted_rankings.test.sql"
  sql < "$root/db/migrations/0054_named_ranking_policy_review.up.sql"
  sql < "$root/db/tests/0054_named_ranking_policy_review.test.sql"
  sql < "$root/db/migrations/0055_named_provenance_event_review.up.sql"
  sql < "$root/db/tests/0055_named_provenance_event_review.test.sql"
  sql < "$root/db/migrations/0056_failclosed_ranked_feed_read.up.sql"
  sql < "$root/db/tests/0056_failclosed_ranked_feed_read.test.sql"
  sql < "$root/db/migrations/0057_minimum_two_codepoint_tokens.up.sql"
  sql < "$root/db/tests/0057_minimum_two_codepoint_tokens.test.sql"
  sql < "$root/db/migrations/0057_minimum_two_codepoint_tokens.down.sql"
  sql < "$root/db/migrations/0056_failclosed_ranked_feed_read.down.sql"
  sql < "$root/db/migrations/0055_named_provenance_event_review.down.sql"
  sql < "$root/db/migrations/0054_named_ranking_policy_review.down.sql"
  sql < "$root/db/migrations/0053_reviewed_weighted_rankings.down.sql"
  sql < "$root/db/migrations/0052_rewritten_syndication.down.sql"
  sql < "$root/db/migrations/0051_rank_unicode_freshness.down.sql"
  sql < "$root/db/tests/0050_cross_site_syndication.test.sql"
  sql < "$root/db/migrations/0050_reviewed_feed_endpoints.down.sql"
  sql < "$root/db/migrations/0049_approved_feed_rankings.down.sql"
  sql < "$root/db/migrations/0048_provider_outbox_delivery_receipt.down.sql"
  sql < "$root/db/migrations/0047_named_provider_job_submission.down.sql"
  sql < "$root/db/migrations/0046_provider_named_sealed_outbox.down.sql"
  sql < "$root/db/migrations/0045_atomic_named_provider_budget_gate.down.sql"
  sql < "$root/db/migrations/0044_named_provider_job_authorization.down.sql"
  sql < "$root/db/migrations/0043_claimed_provider_secret_scope.down.sql"
  sql < "$root/db/migrations/0042_provider_reviewed_model_selection.down.sql"
  sql < "$root/db/migrations/0041_named_live_price_fx_reviews.down.sql"
  sql < "$root/db/migrations/0040_provider_offline_eur_fx_guard.down.sql"
  sql < "$root/db/migrations/0039_provider_one_shot_dispatch_claim.down.sql"
  sql < "$root/db/migrations/0038_provider_worker_budget_guard.down.sql"
  sql < "$root/db/migrations/0037_provider_live_budget_ledger.down.sql"
  sql < "$root/db/migrations/0036_provider_usage_evidence.down.sql"
  sql < "$root/db/migrations/0035_approved_feed_candidate_projection.down.sql"
  sql < "$root/db/migrations/0034_atomic_source_export_authority.down.sql"
  sql < "$root/db/migrations/0033_guarded_feed_commit.down.sql"
  sql < "$root/db/migrations/0032_feed_runtime_source_authorization.down.sql"
  sql < "$root/db/migrations/0031_personal_editor_exports.down.sql"
  sql < "$root/db/migrations/0030_editorial_checkpoints.down.sql"
  sql < "$root/db/migrations/0029_named_editor_db_gateway.down.sql"
  sql < "$root/db/migrations/0028_feed_candidate_projection.down.sql"
  sql < "$root/db/migrations/0027_editorial_profiles.down.sql"
  sql < "$root/db/migrations/0026_editorial_research_persistence.down.sql"
  sql < "$root/db/migrations/0025_editorial_timeline_contract.down.sql"
  sql < "$root/db/migrations/0024_editorial_timeline.down.sql"
  sql < "$root/db/migrations/0023_two_person_host_grants.down.sql"
  sql < "$root/db/migrations/0022_independent_host_approval.down.sql"
  sql < "$root/db/migrations/0021_source_transition_guard.down.sql"
  sql < "$root/db/migrations/0020_source_admin_registry.down.sql"
  sql < "$root/db/migrations/0019_feed_poll_contract.down.sql"
  sql < "$root/db/migrations/0018_ai_provider_named_audit.down.sql"
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
echo "PASS: reversible 0001-0057 migrations, source authority, leases and budgets twice"
