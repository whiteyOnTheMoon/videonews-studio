#!/usr/bin/env bash
# Operator-run P1-07 probe-only worker canary. No editorial side effects.
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ACTION="${1:-}"
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 ]] || die 'usage: bash scripts/p1_07_worker_canary.sh preflight|build|start|status|stop'
case "$ACTION" in preflight|build|start|status|stop) ;; *) die "invalid action" ;; esac

project="videonews-studio"
ci_mode=0
if [[ -n "${VNS_CI_WORKER_PROJECT:-}" ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true &&
     "${GITHUB_REPOSITORY:-}" == whiteyOnTheMoon/videonews-studio &&
     "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ &&
     "$VNS_CI_WORKER_PROJECT" == vns-p107-worker-ci ]] ||
    die "CI override requires trusted disposable GitHub Actions"
  project="$VNS_CI_WORKER_PROJECT"
  ci_mode=1
fi
worker="$project-worker-1"
redis="$project-redis-1"
image="vns-worker:local"

compose() {
  docker compose -p "$project" -f compose.yaml -f deploy/compose.worker.yaml \
    --profile data --profile worker "$@"
}
get_health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null ||
    die "cannot inspect $1"
}
check_labels() {
  local name="$1" service="$2" p s
  p="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$name" 2>/dev/null)" ||
    die "container $name missing"
  s="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$name")"
  [[ "$p" == "$project" && "$s" == "$service" ]] ||
    die "container $name has incorrect Compose identity"
}
check_running_data() {
  # Compose bind-mounted secrets preserve host ownership. The official Node
  # runtime uses UID 1000 and the file remains private mode 0600.
  [[ -f secrets/redis_password && ! -L secrets/redis_password ]] ||
    die "worker Redis secret missing or symlinked"
  [[ "$(stat -c %u:%a secrets/redis_password)" == 1000:600 ]] ||
    die "worker Redis secret must be owned by UID 1000 with mode 0600"
  check_labels "$redis" redis
  [[ "$(get_health "$redis")" == healthy ]] || die "Redis is not healthy"
  [[ -z "$(docker port "$redis")" ]] || die "Redis exposes a host port"
  if [[ "$ci_mode" == 0 ]]; then
    local pg="$project-postgres-1"
    check_labels "$pg" postgres
    [[ "$(get_health "$pg")" == healthy ]] || die "PostgreSQL is not healthy"
    [[ -z "$(docker port "$pg")" ]] || die "PostgreSQL exposes a host port"
    local name
    for name in videonews-studio-api-1 videonews-studio-web-1; do
      [[ "$(get_health "$name")" == healthy ]] ||
        die "existing web/API not healthy: $name"
    done
    [[ "$(get_health videonews-studio-cloudflared)" == running ]] ||
      die "Cloudflare tunnel is not running"
    python3 scripts/p1_07_redis_auth_preflight.py ||
      die "Redis credentials and isolated network not verified"
  fi
}
check_resources() {
  if [[ "$ci_mode" == 1 ]]; then return; fi
  local mib kib percent
  mib="$(free -m | awk '$1 == "Mem:" {print $7}')"
  kib="$(df -Pk / | awk 'NR==2 {print $4}')"
  percent="$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')"
  [[ "$mib" =~ ^[0-9]+$ && "$kib" =~ ^[0-9]+$ && "$percent" =~ ^[0-9]+$ ]] ||
    die "cannot determine VPS resource limits"
  (( mib >= 2400 && kib >= 20 * 1024 * 1024 && percent < 85 )) ||
    die "insufficient RAM or disk headroom for an isolated worker build"
  printf 'PASS: worker build headroom: %s MiB RAM, %s KiB disk, %s%% used\n' "$mib" "$kib" "$percent"
}
check_source() {
  [[ -z "$(git status --porcelain)" ]] || die "dirty checkout"
  if [[ "$ci_mode" == 0 ]]; then
    [[ "$(git branch --show-current)" == main ]] || die "operator must use main"
  fi
  [[ -f Dockerfile.worker && -f deploy/compose.worker.yaml ]] ||
    die "worker build or Compose overlay missing"
}
check_config() {
  compose --profile preview config --format json |
    python3 scripts/p1_07_readiness.py --worker-overlay >/dev/null ||
    die "merged Compose configuration failed readiness validation"
}
absent_worker() {
  if docker container inspect "$worker" >/dev/null 2>&1; then
    die "worker container already exists; refuse to recreate it"
  fi
}
check_running_image() {
  # A newer Git checkout does not retroactively replace the running image.
  # For status, validate the deployed image and its provenance independently.
  local running tagged revision
  running="$(docker inspect --format '{{.Image}}' "$worker")" ||
    die "running worker image cannot be inspected"
  tagged="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)" ||
    die "locally labelled worker image missing"
  [[ "$running" == "$tagged" ]] ||
    die "running worker image differs from the local image tag"
  revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] ||
    die "worker image lacks a valid build revision"
  git merge-base --is-ancestor "$revision" HEAD ||
    die "running worker revision is not in local Git history"
}
check_image() {
  local revision expected
  expected="$(git rev-parse HEAD)"
  revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null)" ||
    die "worker image missing; run build first"
  [[ "$revision" == "$expected" ]] ||
    die "worker image is not stamped with current reviewed checkout"
}
preflight() {
  check_source
  check_resources
  check_running_data
  check_config
  absent_worker
  echo "PASS: probe worker preflight; no containers changed"
}
case "$ACTION" in
  preflight) preflight ;;
  build)
    preflight
    if docker image inspect "$image" >/dev/null 2>&1; then
      die "worker image tag already exists; refuse to overwrite"
    fi
    echo "Building ONLY probe worker; no web/API image or container changes"
    docker build --pull=false --file Dockerfile.worker --target worker \
      --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
      --tag "$image" .
    check_image
    check_resources
    echo "PASS: commit-labelled probe worker image built"
    ;;
  start)
    preflight
    check_image
    # --no-deps is crucial: existing data services are not to be recreated.
    compose up -d --no-deps --no-build --pull never worker
    check_labels "$worker" worker
    [[ -z "$(docker port "$worker")" ]] ||
      die "worker has a published host port"
    started=0
    for _ in $(seq 1 12); do
      if [[ "$(get_health "$worker")" == running ]] &&
         docker logs "$worker" 2>&1 | grep -q 'probe worker ready (concurrency: 1)'; then
        started=1
        break
      fi
      sleep 2
    done
    [[ "$started" == 1 ]] ||
      die "probe worker has not confirmed authenticated startup; inspect safely and stop if needed"
    check_running_data
    echo "PASS: probe-only worker running with concurrency=1; editorial jobs remain disabled"
    ;;
  status)
    check_labels "$worker" worker
    [[ "$(get_health "$worker")" == running ]] ||
      die "worker not running"
    [[ -z "$(docker port "$worker")" ]] ||
      die "unexpected worker public port"
    check_running_image
    check_running_data
    echo "PASS: worker running from verified earlier commit, no public port, PostgreSQL/Redis still healthy"
    ;;
  stop)
    check_labels "$worker" worker
    compose stop worker
    echo "PASS: only probe worker stopped; volumes retained"
    ;;
esac
