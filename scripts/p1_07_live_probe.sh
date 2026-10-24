#!/usr/bin/env bash
# One retained harmless P1-07 probe. Never processes an editorial job.
set -Eeuo pipefail
umask 077
cd "$(dirname -- "$BASH_SOURCE")/.." || exit 1
[[ $# == 0 ]] || { echo "REFUSED: no arguments accepted" >&2; exit 1; }
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }

project=videonews-studio
job_id=p107-live-one-time-probe
ci=0
if [[ -v VNS_CI_WORKER_PROJECT ]]; then
  [[ -v GITHUB_ACTIONS && "$GITHUB_ACTIONS" == true &&
     -v CI && "$CI" == true &&
     -v GITHUB_REPOSITORY && "$GITHUB_REPOSITORY" == whiteyOnTheMoon/videonews-studio &&
     -v GITHUB_RUN_ID && "$GITHUB_RUN_ID" =~ ^[0-9]+$ &&
     "$VNS_CI_WORKER_PROJECT" == vns-p107-worker-ci ]] ||
    die "CI override requires trusted disposable GitHub Actions"
  project="$VNS_CI_WORKER_PROJECT"
  job_id=p107-disposable-one-time-probe
  ci=1
fi
[[ -z "$(git status --porcelain)" ]] || die "unreviewed local changes"
if [[ "$ci" == 0 ]]; then
  [[ "$(git branch --show-current)" == main ]] || die "live probe requires main"
fi
worker="$project-worker-1"
redis="$project-redis-1"
check_service() {
  local name="$1" service="$2" p s
  p="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$name" 2>/dev/null)" ||
    die "expected container not present"
  s="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$name")"
  [[ "$p" == "$project" && "$s" == "$service" ]] ||
    die "unexpected Docker Compose identity"
  [[ -z "$(docker port "$name")" ]] || die "service has published host ports"
  networks="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$name")"
  [[ "$networks" == "$project"_backend" " ]] || die "service uses unexpected network"
}
check_service "$worker" worker
check_service "$redis" redis
[[ "$(docker inspect -f '{{.State.Status}}' "$worker")" == running ]] ||
  die "worker not running"
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$redis")" == healthy ]] ||
  die "Redis not healthy"

running_image="$(docker inspect -f '{{.Image}}' "$worker")"
tagged_image="$(docker image inspect -f '{{.Id}}' vns-worker:local 2>/dev/null)" ||
  die "locally labelled worker image missing"
[[ "$running_image" == "$tagged_image" ]] || die "worker image differs from local tag"
revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' vns-worker:local)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "worker image missing revision label"
git merge-base --is-ancestor "$revision" HEAD ||
  die "running worker build is not in reviewed repository history"

if [[ "$ci" == 0 ]]; then
  check_service "$project-postgres-1" postgres
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$project-postgres-1")" == healthy ]] ||
    die "PostgreSQL unhealthy"
  [[ "$(docker inspect -f '{{.State.Health.Status}}' videonews-studio-api-1)" == healthy ]] ||
    die "existing API unhealthy"
  [[ "$(docker inspect -f '{{.State.Health.Status}}' videonews-studio-web-1)" == healthy ]] ||
    die "existing Web unhealthy"
  [[ "$(docker inspect -f '{{.State.Status}}' videonews-studio-cloudflared)" == running ]] ||
    die "tunnel not running"
  python3 scripts/p1_07_redis_auth_preflight.py ||
    die "Redis ACL verification refused"
  memory="$(free -m | awk '$1=="Mem:" {print $7}')"
  disk="$(df -Pk / | awk 'NR==2 {print $4}')"
  [[ "$memory" =~ ^[0-9]+$ && "$disk" =~ ^[0-9]+$ ]] || die "resource metrics unavailable"
  (( memory >= 1800 && disk >= 15 * 1024 * 1024 )) ||
    die "insufficient memory or disk headroom"
fi

echo "PASS: approved probe-only worker and private Redis verified"
# The fixed job ID is single-use. Never delete the retained outcome or retry
# automatically if the command times out.
timeout 40s docker exec -i -e "VNS_P107_PROBE_ID=$job_id" "$worker" node --input-type=module <<'JS'
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { readFileSync } from "node:fs";

const settings = {
  host: "redis", port: 6379, username: "vns_worker",
  password: readFileSync("/run/secrets/redis_password", "utf8").trim(),
  maxRetriesPerRequest: null,
};
const connection = new Redis(settings);
const events = new QueueEvents("vns-jobs", {
  connection: new Redis(settings), prefix: "bull:vns",
});
const queue = new Queue("vns-jobs", { connection, prefix: "bull:vns" });
let ok = false;
try {
  const id = process.env.VNS_P107_PROBE_ID;
  if (!/^[a-z0-9-]+$/.test(id ?? "")) throw new Error("invalid probe ID");
  await events.waitUntilReady();
  if (await queue.getJob(id)) throw new Error("probe already exists");
  const job = await queue.add("probe", { kind: "probe" }, {
    jobId: id, attempts: 1, removeOnComplete: false, removeOnFail: false,
  });
  const result = await job.waitUntilFinished(events, 15000);
  if (result?.ok !== true || await job.getState() !== "completed") {
    throw new Error("probe failed");
  }
  console.log("PASS: harmless live probe completed; Redis evidence retained");
  ok = true;
} catch {
  console.error("REFUSED: probe failed or already exists; do not retry");
}
// One-shot helper; do not hang while waiting for QueueEvents blocking reads.
process.exit(ok ? 0 : 1);
JS
echo "PASS: live probe completed without editorial jobs or Docker changes"
