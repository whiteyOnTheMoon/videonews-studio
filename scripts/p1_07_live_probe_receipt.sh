#!/usr/bin/env bash
# Verify the already-retained P1-07 probe without sending another job.
# No INSERT, UPDATE, DELETE, Redis mutation, Docker start or restart.
set -Eeuo pipefail
umask 077
cd "$(dirname -- "$BASH_SOURCE")/.." || exit 1
die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }
[[ $# == 0 ]] || die "no arguments accepted"
[[ -z "$(git status --porcelain)" ]] || die "Git checkout has unreviewed changes"

project=videonews-studio
job_id=p107-live-one-time-probe
ci=0
if [[ -v VNS_CI_WORKER_PROJECT ]]; then
  [[ -v GITHUB_ACTIONS && "$GITHUB_ACTIONS" == true &&
     -v CI && "$CI" == true &&
     -v GITHUB_REPOSITORY && "$GITHUB_REPOSITORY" == whiteyOnTheMoon/videonews-studio &&
     -v GITHUB_RUN_ID && "$GITHUB_RUN_ID" =~ ^[0-9]+$ &&
     "$VNS_CI_WORKER_PROJECT" == vns-p107-worker-ci ]] ||
    die "fixture override allowed only for disposable GitHub Actions"
  project="$VNS_CI_WORKER_PROJECT"
  job_id=p107-disposable-one-time-probe
  ci=1
else
  [[ "$(git branch --show-current)" == main ]] || die "live audit requires main"
fi

worker="$project-worker-1"
redis="$project-redis-1"
check_service() {
  local container="$1" service="$2" p s network
  p="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null)" ||
    die "expected container is absent"
  s="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container")"
  [[ "$p" == "$project" && "$s" == "$service" ]] ||
    die "unexpected Compose container identity"
  [[ -z "$(docker port "$container")" ]] || die "unexpected host port"
  network="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container")"
  [[ "$network" == "$project"_backend" " ]] || die "unexpected container network"
}
check_service "$worker" worker
check_service "$redis" redis
[[ "$(docker inspect -f '{{.State.Status}}' "$worker")" == running ]] ||
  die "probe worker is not running"
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$redis")" == healthy ]] ||
  die "authenticated Redis is not healthy"

image_id="$(docker inspect -f '{{.Image}}' "$worker")"
local_id="$(docker image inspect -f '{{.Id}}' vns-worker:local 2>/dev/null)" ||
  die "expected local image tag missing"
[[ "$image_id" == "$local_id" ]] || die "running worker has unexpected image"
revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' vns-worker:local)"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "worker image missing Git build provenance"
git merge-base --is-ancestor "$revision" HEAD ||
  die "worker build revision not in reviewed checkout history"

if [[ "$ci" == 0 ]]; then
  pg="$project-postgres-1"
  check_service "$pg" postgres
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$pg")" == healthy ]] ||
    die "PostgreSQL not healthy"
  [[ "$(docker inspect -f '{{.State.Health.Status}}' videonews-studio-api-1)" == healthy ]] ||
    die "API not healthy"
  [[ "$(docker inspect -f '{{.State.Health.Status}}' videonews-studio-web-1)" == healthy ]] ||
    die "Web not healthy"
  [[ "$(docker inspect -f '{{.State.Status}}' videonews-studio-cloudflared)" == running ]] ||
    die "Cloudflare tunnel not running"
  python3 scripts/p1_07_redis_auth_preflight.py ||
    die "named Redis authentication preflight refused"
fi

echo "PASS: existing probe worker and Redis isolation verified"
timeout 20s docker exec -i -e "VNS_P107_PROBE_ID=$job_id" "$worker" node --input-type=module <<'JS'
import { Queue } from "bullmq";
import Redis from "ioredis";
import { readFileSync } from "node:fs";

const connection = new Redis({
  host: "redis",
  port: 6379,
  username: "vns_worker",
  password: readFileSync("/run/secrets/redis_password", "utf8").trim(),
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  enableOfflineQueue: false,
});
const queue = new Queue("vns-jobs", { connection, prefix: "bull:vns" });
let ok = false;
try {
  const id = process.env.VNS_P107_PROBE_ID;
  if (!/^[a-z0-9-]+$/.test(id ?? "")) throw new Error("invalid probe ID");
  const job = await queue.getJob(id);
  if (!job ||
      job.id !== id ||
      job.name !== "probe" ||
      job.data?.kind !== "probe" ||
      Object.keys(job.data ?? {}).length !== 1 ||
      job.opts.attempts !== 1 ||
      job.opts.removeOnComplete !== false ||
      job.opts.removeOnFail !== false ||
      job.attemptsMade !== 1 ||
      job.returnvalue?.ok !== true ||
      await job.getState() !== "completed") {
    throw new Error("stored probe receipt failed validation");
  }
  console.log("PASS: retained completed probe is consistent; no new Redis job enqueued");
  ok = true;
} catch {
  console.error("REFUSED: probe receipt absent or invalid");
}
process.exit(ok ? 0 : 1);
JS

if [[ "$ci" == 0 ]]; then
  # Only SELECT, and explicit schema qualification. This intentionally fails
  # closed if new editorial jobs/accounts appeared in the experimental DB.
  totals="$(docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000' \
    "$pg" psql -X -w -A -t -q -v ON_ERROR_STOP=1 \
    -U vns -d videonews -c \
    "SELECT (SELECT count(*) FROM vns.schema_migrations) || '|' ||
            (SELECT max(version) FROM vns.schema_migrations) || '|' ||
            (SELECT count(*) FROM vns.jobs) || '|' ||
            (SELECT count(*) FROM vns.job_outbox) || '|' ||
            (SELECT count(*) FROM vns.editor_operator_registry) || '|' ||
            (SELECT count(*) FROM pg_roles
             WHERE rolname IN ('vns_outbox_dispatch', 'vns_job_status_sync',
                               'vns_research_writer')
               AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
               AND NOT rolcreaterole AND NOT rolcreatedb) || '|' ||
            (SELECT count(*) FROM pg_roles
             WHERE rolname IN ('vns_outbox_dispatch_login',
                               'vns_job_status_sync_login',
                               'vns_research_writer_login')
               AND rolcanlogin AND rolinherit AND NOT rolsuper
               AND NOT rolcreaterole AND NOT rolcreatedb
               AND NOT rolreplication AND NOT rolbypassrls) || '|' ||
            (SELECT count(*) FROM pg_auth_members m
             JOIN pg_roles g ON g.oid = m.roleid
             JOIN pg_roles u ON u.oid = m.member
             WHERE (g.rolname, u.rolname) IN (
               ('vns_outbox_dispatch', 'vns_outbox_dispatch_login'),
               ('vns_job_status_sync', 'vns_job_status_sync_login'),
               ('vns_research_writer', 'vns_research_writer_login'))
               AND m.inherit_option) || '|' ||
            (SELECT count(*) FROM pg_auth_members m
             JOIN pg_roles u ON u.oid = m.member
             WHERE u.rolname IN ('vns_outbox_dispatch_login',
                                 'vns_job_status_sync_login',
                                 'vns_research_writer_login'))")" ||
    die "PostgreSQL read-only ledger check failed"
  [[ "$totals" == '12|0012_runtime_least_privilege|0|0|0|3|3|3|3' ]] ||
    die "PostgreSQL ledger or scoped runtime identity baseline drifted"
  echo "PASS: 12 migrations, zero editorial jobs/outbox/operators, three scoped runtime logins"
fi
echo "PASS: probe receipt audit finished without modifying services or state"
