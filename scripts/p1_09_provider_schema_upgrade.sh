#!/usr/bin/env bash
# P1-09: guarded, operator-controlled additive schema rollout, no backups.
# No service restart, database deletion or provider activation.
set -Eeuo pipefail
umask 077
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
[[ $# -eq 1 ]] || { echo "REFUSED: status|preflight|apply" >&2; exit 1; }
action="$1"
[[ "$action" =~ ^(status|preflight|apply)$ ]] || { echo "REFUSED: status|preflight|apply" >&2; exit 1; }
die() { echo "REFUSED: $*" >&2; exit 1; }
project=videonews-studio
if [[ -n "$(printenv VNS_P109_CI_PROJECT || true)" ]]; then
  [[ "$(printenv GITHUB_ACTIONS || true)" == true &&
    "$(printenv CI || true)" == true &&
    "$(printenv GITHUB_REPOSITORY || true)" == whiteyOnTheMoon/videonews-studio &&
    "$(printenv GITHUB_RUN_ID || true)" =~ ^[0-9]+$ &&
    "$VNS_P109_CI_PROJECT" == vns-p109-upgrade-ci ]] ||
    die "CI target override is forbidden outside trusted disposable CI"
  project="$VNS_P109_CI_PROJECT"
else
  [[ "$(git branch --show-current)" == main ]] || die "operator checkout must be on main"
fi
[[ -z "$(git status --porcelain)" ]] || die "repository has local changes"
container="$project-postgres-1"
query() {
  docker exec "$container" psql -X -A -t -q -v ON_ERROR_STOP=1 -U vns -d videonews -c "$1"
}
check_instance() {
  local label_project label_service health identity
  label_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null)" ||
    die "expected VideoNews PostgreSQL container missing"
  label_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")"
  [[ "$label_project" == "$project" && "$label_service" == postgres ]] ||
    die "unexpected container project or service"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  [[ "$health" == healthy ]] || die "PostgreSQL is not healthy"
  identity="$(query "SELECT current_user || '|' || current_database() || '|' || current_setting('is_superuser') || '|' || current_setting('server_version_num')")" ||
    die "cannot authenticate to PostgreSQL"
  [[ "$identity" =~ ^vns\|videonews\|on\|17[0-9]{4}$ ]] ||
    die "unexpected PostgreSQL database/identity/version"
}
check_capacity() {
  [[ "$project" != vns-p109-upgrade-ci ]] || return 0
  local available_kib available_mib used_percent
  available_kib="$(df -Pk / | awk 'NR==2 {print $4}')"
  available_mib="$(free -m | awk '$1=="Mem:" {print $7}')"
  used_percent="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
  [[ "$available_kib" =~ ^[0-9]+$ && "$available_mib" =~ ^[0-9]+$ &&
    "$used_percent" =~ ^[0-9]+$ ]] || die "resource metrics unavailable"
  (( available_kib >= 15*1024*1024 && available_mib >= 1800 && used_percent < 85 )) ||
    die "insufficient disk or available memory"
}
baseline="0001_editorial_core,0002_job_outbox,0003_research_requests,0004_research_evidence,0005_editorial_review_audit,0006_offline_role_boundaries,0007_runtime_role_boundaries,0008_editor_session_revocation,0009_scoped_editor_review,0010_editor_account_lifecycle_audit,0011_operator_registry_governance,0012_runtime_least_privilege"
target_names="0013_synthetic_token_usage 0014_synthetic_ai_budget_reservations 0015_ai_provider_admin_configuration 0016_ai_provider_audit_store 0017_ai_provider_mutation_admission 0018_ai_provider_named_audit"
check_files() {
  local name
  for name in $target_names; do
    [[ -s "db/migrations/$name.up.sql" ]] || die "migration missing: $name"
  done
}
check_baseline() {
  [[ "$(query "SELECT string_agg(version,',' ORDER BY version) FROM vns.schema_migrations")" == "$baseline" ]] ||
    die "database ledger not at exact 0012 baseline"
  [[ "$(query "SELECT count(*) FROM pg_roles WHERE rolname IN ('vns_provider_config_executor','vns_provider_config_writer')")" == 0 ]] ||
    die "provider roles already exist"
  [[ "$(query "SELECT to_regclass('vns.job_token_usage') IS NULL AND to_regclass('vns.ai_provider_settings') IS NULL AND to_regclass('vns.synthetic_ai_reservations') IS NULL")" == t ]] ||
    die "provider/usage objects already exist"
}
check_instance
case "$action" in
  status)
    echo "Git: $(git rev-parse --short HEAD)"
    query "SELECT version FROM vns.schema_migrations ORDER BY version"
    ;;
  preflight|apply)
    check_capacity
    check_files
    check_baseline
    echo "PASS: correct PostgreSQL 17, exact 0012 ledger, adequate headroom, no target objects"
    if [[ "$action" == apply ]]; then
      if [[ "$project" == videonews-studio ]]; then
        [[ "$(printenv VNS_P1_NO_BACKUP_RISK_ACCEPTED || true)" == I_ACCEPT_UNRECOVERABLE_LOSS ]] ||
          die "explicit no-backup risk acknowledgement required"
      fi
      echo "Applying migrations 0013..0018 without enabling providers or making API calls"
      for name in $target_names; do
        echo "Applying $name"
        docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U vns -d videonews \
          < "$ROOT/db/migrations/$name.up.sql" ||
          die "$name failed; do not retry, reset or rollback automatically"
        [[ "$(query "SELECT count(*) FROM vns.schema_migrations WHERE version='$name'")" == 1 ]] ||
          die "migration $name missing ledger row; investigate"
      done
      [[ "$(query "SELECT count(*) FROM vns.schema_migrations")" == 18 ]] ||
        die "unexpected final migration count"
      [[ "$(query "SELECT count(*) FROM vns.ai_provider_settings WHERE enabled OR provider NOT IN ('openai','google_gemini')")" == 0 ]] ||
        die "unexpected provider activation"
      [[ "$(query "SELECT count(*) FROM vns.ai_provider_sealed_credentials")" == 0 ]] ||
        die "unexpected key material in new table"
      [[ "$(query "SELECT count(*) FROM pg_roles WHERE rolname='vns_provider_config_writer' AND rolcanlogin")" == 0 ]] ||
        die "writer must remain NOLOGIN"
      [[ "$(query "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE r.rolname='vns_provider_config_writer'")" == 0 ]] ||
        die "writer must have no members"
      echo "PASS: six additional migrations; provider execution disabled and no keys provisioned"
    fi
    ;;
esac
