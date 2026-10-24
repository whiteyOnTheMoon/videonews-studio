#!/usr/bin/env bash
# P1-07: operator-executed fresh-schema migration; no credentials printed.
# Separate full recovery/backup acceptance is NOT implied by this operation.
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ACTION="${1:-}"
[[ $# -eq 1 && "$ACTION" =~ ^(preflight|apply|status)$ ]] || {
  echo "REFUSED: use preflight|apply|status" >&2
  exit 1
}
die() { echo "REFUSED: $*" >&2; exit 1; }

project="videonews-studio"
# Only a GitHub Actions run for this repository may select its isolated
# disposable project; normal VPS execution always targets VideoNews only.
if [[ -n "${VNS_CI_MIGRATION_PROJECT:-}" ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true &&
     "${GITHUB_REPOSITORY:-}" == whiteyOnTheMoon/videonews-studio &&
     "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ &&
     "$VNS_CI_MIGRATION_PROJECT" == vns-p107-migrate-ci ]] ||
    die "migration target override requires trusted CI"
  project="$VNS_CI_MIGRATION_PROJECT"
else
  [[ "$(git branch --show-current)" == main ]] || die "operator checkout must be on main"
fi
[[ -z "$(git status --porcelain)" ]] || die "repository has unreviewed local changes"
container="$project-postgres-1"

migrations=(
  0001_editorial_core
  0002_job_outbox
  0003_research_requests
  0004_research_evidence
  0005_editorial_review_audit
  0006_offline_role_boundaries
  0007_runtime_role_boundaries
  0008_editor_session_revocation
  0009_scoped_editor_review
  0010_editor_account_lifecycle_audit
  0011_operator_registry_governance
)

query() {
  docker exec "$container" psql -X -A -t -q -v ON_ERROR_STOP=1     -U vns -d videonews -c "$1"
}
check_instance() {
  local label_project label_service health identity
  label_project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null)" ||
    die "PostgreSQL container missing"
  label_service="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")"
  [[ "$label_project" == "$project" && "$label_service" == postgres ]] ||
    die "container is not the expected isolated VideoNews PostgreSQL"
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  [[ "$health" == healthy ]] || die "PostgreSQL is not healthy"
  identity="$(query "SELECT current_user || '|' || current_database() || '|' || current_setting('is_superuser') || '|' || current_setting('server_version_num')")" ||
    die "cannot authenticate over internal PostgreSQL socket"
  [[ "$identity" =~ ^vns\|videonews\|on\|17[0-9]{4}$ ]] ||
    die "unexpected DB/user/privilege or PostgreSQL version"
}
check_fresh() {
  local count role_count
  count="$(query "SELECT count(*) FROM pg_namespace WHERE nspname = 'vns'")"
  [[ "$count" == 0 ]] || die "existing vns schema; do not overwrite or rerun migrations"
  role_count="$(query "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'vns\\_%' ESCAPE '\\'")"
  [[ "$role_count" == 0 ]] || die "existing vns_* roles; refuse partially initialized cluster"
}
check_capacity() {
  local available_kib available_mib used_percent
  available_kib="$(df -Pk / | awk 'NR == 2 {print $4}')"
  available_mib="$(free -m | awk '$1 == "Mem:" {print $7}')"
  used_percent="$(df -P / | awk 'NR == 2 {gsub("%", "", $5); print $5}')"
  [[ "$available_kib" =~ ^[0-9]+$ && "$available_mib" =~ ^[0-9]+$ &&
     "$used_percent" =~ ^[0-9]+$ ]] || die "resource metrics unavailable"
  (( available_kib >= 15 * 1024 * 1024 && used_percent < 85 && available_mib >= 1800 )) ||
    die "disk or RAM below previously approved safe thresholds"
}
check_files() {
  local name
  for name in "${migrations[@]}"; do
    [[ -s "db/migrations/$name.up.sql" ]] || die "migration file missing: $name"
  done
}
check_instance
case "$ACTION" in
  status)
    if [[ "$(query "SELECT count(*) FROM pg_namespace WHERE nspname = 'vns'")" == 0 ]]; then
      echo "P1-07 schema: absent; no migrations applied"
    else
      [[ "$(query "SELECT to_regclass('vns.schema_migrations') IS NOT NULL")" == t ]] ||
        die "vns schema exists without migration ledger"
      query "SELECT version FROM vns.schema_migrations ORDER BY version"
    fi
    ;;
  preflight|apply)
    check_capacity
    check_files
    check_fresh
    echo "PASS: isolated PostgreSQL healthy, correct database, empty schema and adequate headroom"
    if [[ "$ACTION" == apply ]]; then
      echo "Applying exactly 11 reviewed migrations; no seed data or human accounts created"
      for name in "${migrations[@]}"; do
        echo "Applying $name"
        # Each existing SQL migration manages its own BEGIN/COMMIT.
        # Do not auto-replay or delete state if an intermediate step fails.
        docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1           -U vns -d videonews < "db/migrations/$name.up.sql" ||
          die "migration $name failed; preserve state and investigate before retry"
      done
      [[ "$(query "SELECT count(*) FROM vns.schema_migrations")" == 11 ]] ||
        die "wrong applied migration count"
      for name in "${migrations[@]}"; do
        [[ "$(query "SELECT count(*) FROM vns.schema_migrations WHERE version='$name'")" == 1 ]] ||
          die "missing migration record: $name"
      done
      [[ "$(query "SELECT count(*) FROM vns.editor_operator_registry")" == 0 ]] ||
        die "unexpected operator registry entries"
      echo "PASS: all 11 migrations verified; operator registry empty; no worker or API flag enabled"
    fi
    ;;
esac
