#!/usr/bin/env bash
# P1-07: operator-run, targeted data-container canary only.
# Never touches existing web/API/tunnel or another project's containers.
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ACTION="${1:-}"

die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 1 ]] || die 'usage: bash scripts/p1_07_data_canary.sh preflight|provision|start|status|stop'
case "$ACTION" in preflight|provision|start|status|stop) ;; *) die 'unsupported action' ;; esac

compose() {
  docker compose --project-name videonews-studio -f compose.yaml --profile data "$@"
}
check_repo() {
  [[ "$(git rev-parse --show-toplevel)" == "$ROOT" ]] || die 'repository root mismatch'
  [[ "$(git branch --show-current)" == main ]] || die 'checkout main before using this helper'
  [[ -z "$(git status --porcelain)" ]] || die 'tracked/untracked repository changes; review first'
}
check_capacity() {
  local available_kib available_mib used_percent
  available_kib="$(df -Pk / | awk 'NR == 2 { print $4 }')"
  available_mib="$(free -m | awk '$1 == "Mem:" { print $7 }')"
  used_percent="$(df -P / | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
  [[ "$available_kib" =~ ^[0-9]+$ && "$available_mib" =~ ^[0-9]+$ && "$used_percent" =~ ^[0-9]+$ ]] || die 'unable to determine resources'
  (( available_kib >= 15 * 1024 * 1024 )) || die 'less than 15 GiB disk headroom'
  (( used_percent < 85 )) || die 'root filesystem at or above 85% capacity'
  (( available_mib >= 1800 )) || die 'less than 1800 MiB available RAM'
  printf 'Resource preflight passed: %s MiB available RAM, %s KiB free, %s%% disk used\n' "$available_mib" "$available_kib" "$used_percent"
}
check_web_untouched() {
  local service state
  for service in videonews-studio-web-1 videonews-studio-api-1; do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$service" 2>/dev/null)" || die "cannot inspect $service"
    [[ "$state" == healthy ]] || die "$service is not healthy"
  done
  state="$(docker inspect --format '{{.State.Status}}' videonews-studio-cloudflared 2>/dev/null)" || die 'cannot inspect tunnel'
  [[ "$state" == running ]] || die 'existing Cloudflare tunnel not running'
}
ensure_absent() {
  local name
  for name in videonews-studio-postgres-1 videonews-studio-redis-1; do
    if docker ps -a --format '{{.Names}}' | grep -Fxq "$name"; then
      die "$name already exists: do not recreate or overwrite an existing data service"
    fi
  done
}
preflight() {
  check_repo
  docker info --format '{{.ServerVersion}}' >/dev/null || die 'Docker unavailable'
  check_capacity
  check_web_untouched
  ensure_absent
  printf 'PASS: isolated data canary may be prepared; no containers changed.\n'
}
check_credentials() {
  [[ -s secrets/postgres_password && ! -L secrets/postgres_password ]] || die 'PostgreSQL secret absent or unsafe'
  [[ -s secrets/redis_acl && ! -L secrets/redis_acl ]] || die 'Redis ACL secret absent or unsafe'
  [[ -s secrets/redis_password && ! -L secrets/redis_password ]] || die 'Redis password secret absent or unsafe'
  local mode
  mode="$(stat -c %a secrets/postgres_password)"
  [[ "$mode" == 600 ]] || die 'PostgreSQL secret must be mode 0600'
  mode="$(stat -c %a secrets/redis_password)"
  [[ "$mode" == 600 ]] || die 'Redis password secret must be mode 0600'
}
case "$ACTION" in
  preflight)
    preflight
    ;;
  provision)
    preflight
    [[ ! -L secrets ]] || die 'secrets directory is a symlink'
    [[ ! -e secrets/postgres_password && ! -e secrets/redis_acl && ! -e secrets/redis_password ]] || die 'some credentials already exist: refusing rotation/overwrite'
    mkdir -p -m 700 secrets
    python3 - <<'PY'
import os
import secrets

path = "secrets/postgres_password"
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
fd = os.open(path, flags, 0o600)
with os.fdopen(fd, "w", encoding="ascii") as output:
    output.write(secrets.token_urlsafe(48) + "\n")
    output.flush()
    os.fsync(output.fileno())
PY
    python3 scripts/provision_redis_secrets.py secrets
    check_credentials
    printf 'PASS: local secrets created without printing their contents. No containers started.\n'
    ;;
  start)
    preflight
    check_credentials
    compose config --format json | python3 scripts/p1_07_readiness.py >/dev/null || die 'Compose base isolation/readiness refused'
    printf 'Starting ONLY videonews-studio PostgreSQL and Redis; no worker, web, API or tunnel changes.\n'
    compose up -d --no-deps --no-build --pull missing postgres redis
    ready=0
    for attempt in $(seq 1 45); do
      pg="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' videonews-studio-postgres-1 2>/dev/null || true)"
      rd="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' videonews-studio-redis-1 2>/dev/null || true)"
      if [[ "$pg" == healthy && "$rd" == healthy ]]; then ready=1; break; fi
      [[ "$pg" != unhealthy && "$rd" != unhealthy ]] || break
      sleep 2
    done
    if [[ "$ready" != 1 ]]; then
      printf 'FAIL: at least one data service is not healthy. Preserving volumes and logs; use stop action after diagnosis.\n' >&2
      exit 1
    fi
    check_web_untouched
    check_capacity
    printf 'PASS: PostgreSQL and Redis healthy; original web/API/tunnel still healthy; no worker enabled.\n'
    ;;
  status)
    compose ps postgres redis
    printf '\nHost headroom:\n'
    df -h /
    free -h
    ;;
  stop)
    printf 'Stopping ONLY VideoNews PostgreSQL and Redis. Persistent volumes are retained.\n'
    compose stop postgres redis
    ;;
esac
