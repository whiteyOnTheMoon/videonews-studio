#!/usr/bin/env bash
# P1-07: guarded restart of only the existing probe worker.
set -Eeuo pipefail
umask 077
cd "$(dirname -- "$0")/.." || exit 1
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 && ( "$1" == preflight || "$1" == restart ) ]] ||
  die 'usage: bash scripts/p1_07_worker_restart.sh preflight|restart'
action="$1"
project=videonews-studio
expected=p107-live-one-time-probe

if [[ -n "${VNS_CI_WORKER_PROJECT:-}" ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true && "${CI:-}" == true &&
     "${GITHUB_REPOSITORY:-}" == whiteyOnTheMoon/videonews-studio &&
     "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ &&
     "$VNS_CI_WORKER_PROJECT" == vns-p107-worker-ci ]] ||
    die 'CI override refused'
  project="$VNS_CI_WORKER_PROJECT"
  expected=ci-worker-image-smoke,p107-disposable-one-time-probe
else
  [[ "$(git branch --show-current)" == main ]] || die 'must use main'
  mem="$(free -m | awk '$1=="Mem:" {print $7}')"
  disk="$(df -Pk / | awk 'NR==2 {print $4}')"
  [[ "$mem" =~ ^[0-9]+$ && "$disk" =~ ^[0-9]+$ ]] || die 'resource metrics unavailable'
  (( mem >= 1800 && disk >= 15 * 1024 * 1024 )) || die 'low resource headroom'
fi
[[ -z "$(git status --porcelain)" ]] || die 'dirty checkout'
worker="$project-worker-1"

proof() {
  bash scripts/p1_07_worker_canary.sh status || die 'worker unhealthy'
  bash scripts/p1_07_live_probe_receipt.sh || die 'saved probe not verified'
  timeout 25s docker exec -i -e "VNS_P107_EXPECTED_IDS=$expected" "$worker" \
    node --input-type=module < scripts/p1_07_idle_queue_check.mjs ||
    die 'unexpected or incomplete queue inventory'
}
proof
echo 'PASS: idle worker, completed probe and resources verified'
[[ "$action" == preflight ]] && exit 0

# Capture other service IDs and start times; any change is a failed drill.
if [[ "$project" == videonews-studio ]]; then
  other=( videonews-studio-postgres-1 videonews-studio-redis-1
          videonews-studio-web-1 videonews-studio-api-1
          videonews-studio-cloudflared )
else
  other=( "$project-redis-1" )
fi
before="$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' "${other[@]}")" ||
  die 'dependencies could not be inspected'
old_start="$(docker inspect -f '{{.State.StartedAt}}' "$worker")"
echo 'Restarting ONLY the existing probe worker'
docker restart --time 20 "$worker" >/dev/null || die 'worker restart failed'

ready=0
for _ in $(seq 1 15); do
  new_start="$(docker inspect -f '{{.State.StartedAt}}' "$worker" 2>/dev/null || true)"
  state="$(docker inspect -f '{{.State.Status}}' "$worker" 2>/dev/null || true)"
  if [[ "$new_start" != "$old_start" && "$state" == running ]] &&
     docker logs --since "$new_start" "$worker" 2>&1 |
       grep -Fq 'probe worker ready (concurrency: 1)'; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" == 1 ]] || die 'new worker readiness not confirmed'
after="$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' "${other[@]}")" ||
  die 'dependent service inspection failed'
[[ "$before" == "$after" ]] || die 'another VideoNews service changed'
proof
echo 'PASS: only probe worker restarted; retained job and dependencies unchanged'
