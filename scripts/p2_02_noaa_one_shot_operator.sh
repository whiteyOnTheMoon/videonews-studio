#!/usr/bin/env bash
# One approved NOAA metadata-only poll; production operator runs this, never CI.
# Unconditionally preserves the container and historical BullMQ jobs. NO retries.
set -euo pipefail
umask 077

ROOT="/home/ap/www/videonews-studio"
WORKER_SHA="a5c73c9ea5b8fba8a982e423c8eb5b5f42d48031"
IMAGE_TAG="vns-p2-worker:a5c73c9ea5b8"
IMAGE_ID="sha256:0116ba447642645ae81324347ac800fd45991fdf7006676936d7515f285a45ef"
CONTAINER="vns-noaa-single-20261108-a5c73c9"
BACKEND="videonews-studio_backend"
EGRESS="videonews-studio_feed_egress"
BASE="/var/lib/videonews-studio"
SOURCE="$BASE/p2-signed-source"
SECRETS="$BASE/p2-feed-runtime-secrets"
ANCHOR="$BASE/p2-anchor-runtime-secret/vns_feed_source_anchor_password"
ACK="NOAA_SINGLE_METADATA_POLL_ONCE_NO_RETRY"
DENIED="REFUSED: NOAA one-shot admission unavailable; inspect state read-only; do not retry"

refuse() { echo "$DENIED" >&2; exit 2; }
must() { "$@" >/dev/null 2>&1 || refuse; }
# Root must NEVER refresh the operator-owned Git index under umask 077.
repo_git() { git --no-optional-locks -c safe.directory="$ROOT" -C "$ROOT" "$@"; }

# Restrict to read-only preflight, or one separately approved real execution.
case "$#" in
  3)
    test "$1" = "--preflight" && test "$2" = "--expected-sha" || refuse
    ACTION="preflight"
    ;;
  5)
    test "$1" = "--run" && test "$2" = "--expected-sha" &&
      test "$4" = "--approval" && test "$5" = "$ACK" || refuse
    ACTION="run"
    ;;
  *) refuse ;;
esac
SHA="$3"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || refuse
test "$(id -u)" = "0" || refuse
# Refuse a root-owned/rewritten index instead of silently treating git
# status errors as an empty worktree. Repair is a separate operator action.
must test -f "$ROOT/.git/index"
must test ! -L "$ROOT/.git/index"
INDEX_OWNER="$(stat -c '%u:%h' "$ROOT/.git/index" 2>/dev/null)" || refuse
test "$INDEX_OWNER" = "1000:1" || refuse
INDEX_MODE="$(stat -c '%a' "$ROOT/.git/index" 2>/dev/null)" || refuse
case "$INDEX_MODE" in 600|640|644) ;; *) refuse ;; esac
BRANCH="$(repo_git branch --show-current 2>/dev/null)" || refuse
test "$BRANCH" = "main" || refuse
ACTUAL_SHA="$(repo_git rev-parse HEAD 2>/dev/null)" || refuse
test "$ACTUAL_SHA" = "$SHA" || refuse
GIT_STATUS="$(repo_git status --porcelain 2>/dev/null)" || refuse
test -z "$GIT_STATUS" || refuse
# No credential, actual source URL, API token, private key or raw SQL rows logged.

verify_dir() {
  local path="$1" uid="$2" gid="$3" mode="$4"
  must test -d "$path"
  must test ! -L "$path"
  must test "$(stat -c '%u:%g:%a' "$path")" = "$uid:$gid:$mode"
}
verify_file() {
  local path="$1" uid="$2" gid="$3" mode="$4"
  must test -f "$path"
  must test ! -L "$path"
  must test "$(stat -c '%u:%g:%a:%h' "$path")" = "$uid:$gid:$mode:1"
}

must docker info --format '{{.ServerVersion}}'
must test "$(docker network inspect -f '{{.Internal}}' "$BACKEND")" = "true"
must test "$(docker network inspect -f '{{.Internal}}' "$EGRESS")" = "false"
must test "$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')" = "$IMAGE_ID"
must test "$(docker image inspect "$IMAGE_TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$WORKER_SHA"
# Name is fixed. The name remains reserved after a failure or a success.
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then refuse; fi
# Separate non-Compose one-shot containers must not be active either.
RUNNING="$(docker ps --format '{{.Names}}' 2>/dev/null)" || refuse
if printf '%s\n' "$RUNNING" | grep -Eq '^vns-(nasa|noaa|usgs|feed)-'; then refuse; fi

verify_dir "$BASE" 0 0 700
verify_dir "$SOURCE" 0 0 700
verify_dir "$SOURCE/worker-inbox" 10002 10002 700
verify_dir "$SOURCE/worker-checkpoint" 10002 10002 700
verify_file "$SOURCE/trust-material/signing-public.pem" 0 10002 440
verify_dir "$SECRETS" 0 0 700
verify_file "$SECRETS/vns_feed_db_password" 10002 10002 400
verify_file "$SECRETS/vns_feed_producer_redis_password" 10002 10002 400
verify_file "$SECRETS/vns_feed_consumer_redis_password" 10002 10002 400
verify_file "$ANCHOR" 10002 10002 400

# Both fixed witnesses are ROOT-only and read-only. Require exact audited
# source/host/checkpoint/anchor parity and an empty slot before touching Docker.
SIGNED="$(python3 "$ROOT/scripts/p2_02_nasa_signed_sql_readonly_witness.py" --expected-sha "$SHA")" || refuse
printf '%s' "$SIGNED" | python3 -c '
import sys,json
x=json.load(sys.stdin)
assert x["status"]=="parity_reviewable"
assert x["sql_source_revision_10"] is True
assert x["sql_host_revision_10"] is True
assert x["sql_approved_host_subset_equal_signed"] is True
assert x["sql_anchor_digest_matches"] is True
assert x["sql_trust_policy_matches"] is True
assert x["feed_started"] is False
' >/dev/null 2>&1 || refuse

QUEUE="$(python3 "$ROOT/scripts/p2_02_nasa_queue_readonly_preflight.py" --expected-sha "$SHA")" || refuse
printf '%s' "$QUEUE" | python3 -c '
import sys,json
x=json.load(sys.stdin)
assert x["status"]=="reviewable"
assert x["compose_feed_services_quiescent"] is True
assert x["acl_identities_verified"] is True
assert x["distinct_credentials"] is True
assert x["current_slot_job_present"] is False
assert x["previous_slot_job_present"] is False
assert x["counts"]["failed"]==6 and x["counts"]["completed"]==2
for k in ("waiting","active","paused","delayed","prioritized","waiting_children","repeat_schedules","stalled"):
    assert x["counts"][k]==0
' >/dev/null 2>&1 || refuse

# Never use the unrestricted historic feed-claim function in this preflight.
# Query is read-only, returns a single fixed sentinel; URL and candidate
# metadata never leave PostgreSQL. Guard exact NOAA RSS scope and 60m lease.
SQL="$(cat <<'SQL'
WITH source AS (
  SELECT r.revision, item.value AS entry
  FROM vns.admin_source_registry r
  CROSS JOIN LATERAL jsonb_array_elements(r.sources) AS item(value)
  WHERE r.singleton=true AND item.value->>'id'='noaa_news'
)
SELECT CASE WHEN
  current_setting('transaction_read_only')='on'
  AND (SELECT revision=10 FROM vns.admin_source_registry WHERE singleton)
  AND (SELECT revision=10 FROM vns.admin_source_host_approvals WHERE singleton)
  AND (SELECT count(*)=1 AND bool_and(
    entry->>'status'='approved'
    AND entry->>'access'='rss'
    AND entry->>'usage'='metadata_only'
    AND entry->>'baseUrl'='https://www.noaa.gov/'
    AND entry->>'feedUrl'='https://www.noaa.gov/rss.xml'
    AND entry->>'intervalMinutes'='60'
  ) FROM source)
  AND EXISTS (
    SELECT 1 FROM vns.admin_source_host_approvals h
    JOIN LATERAL (
      SELECT a.action,a.source_revision
      FROM vns.admin_source_host_audit a
      WHERE a.host='www.noaa.gov'
      ORDER BY a.revision DESC LIMIT 1
    ) last ON true
    WHERE h.singleton
      AND h.approved_hosts ? 'www.noaa.gov'
      AND last.action='grant'
      AND last.source_revision=10
  )
  AND EXISTS (
    SELECT 1 FROM vns.feed_poll_state
    WHERE source_id='noaa_news' AND next_eligible_at<=clock_timestamp()
  )
THEN 'READY' ELSE 'BLOCKED' END;
SQL
)"
READY="$(docker exec -i \
  -e "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000" \
  videonews-studio-postgres-1 psql -X -w -q -A -t \
  -v ON_ERROR_STOP=1 -U vns -d videonews -c "$SQL" 2>/dev/null)" || refuse
test "$READY" = "READY" || refuse

echo "PASS: NOAA 10/10 signature, rights-scope metadata, image, protected mounts, lease, isolated queue"
echo "INFO: Preflight read-only; no network GET, job, lease claim or Docker modification"
if test "$ACTION" = "preflight"; then exit 0; fi

# Reuse one immutable image ID, not a mutable image tag. Create only ONE
# non-restarting, portless, non-root, read-only-rootfs container, then join
# egress BEFORE first start. Any partial creation stays for operator audit.
echo "=== NOAA EINMALIGEN AUDITIERTEN CONTAINER ANLEGEN ==="
docker create \
  --name "$CONTAINER" \
  --pull never \
  --init \
  --restart no \
  --read-only \
  --user 10002:10002 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 96 \
  --memory 384m \
  --memory-swap 384m \
  --cpus 0.5 \
  --tmpfs /tmp:rw,nosuid,noexec,size=16m \
  --network "$BACKEND" \
  --label vns.audit.scope=noaa_one_shot_metadata \
  --mount "type=bind,source=$SOURCE/worker-inbox,target=/var/lib/vns/feed-source-inbox,readonly" \
  --mount "type=bind,source=$SOURCE/worker-checkpoint,target=/var/lib/vns/feed-source-checkpoint" \
  --mount "type=bind,source=$SOURCE/trust-material/signing-public.pem,target=/run/secrets/vns_feed_source_public_key,readonly" \
  --mount "type=bind,source=$ANCHOR,target=/run/secrets/vns_feed_source_anchor_password,readonly" \
  --mount "type=bind,source=$SECRETS/vns_feed_db_password,target=/run/secrets/vns_feed_db_password,readonly" \
  --mount "type=bind,source=$SECRETS/vns_feed_producer_redis_password,target=/run/secrets/vns_feed_producer_redis_password,readonly" \
  --mount "type=bind,source=$SECRETS/vns_feed_consumer_redis_password,target=/run/secrets/vns_feed_redis_password,readonly" \
  -e NODE_ENV=production \
  -e VNS_FEED_RUNTIME_MODE=single_pass \
  -e VNS_FEED_RUNTIME_ENABLED=true \
  -e VNS_FEED_RUNTIME_OPERATOR_ACK=true \
  -e VNS_FEED_RIGHTS_ATTESTED=true \
  -e VNS_FEED_NETWORK_APPROVED=true \
  -e VNS_FEED_OFFLINE_COMPOSITION_ENABLED=true \
  -e VNS_FEED_OFFLINE_OPERATOR_ACK=true \
  -e VNS_FEED_QUEUE_CONTRACT_ENABLED=true \
  -e VNS_FEED_QUEUE_OPERATOR_ACK=true \
  -e VNS_FEED_BULLMQ_BRIDGE_ENABLED=true \
  -e VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK=true \
  -e VNS_FEED_SIGNED_EXPORT_ENABLED=true \
  -e VNS_FEED_SOURCE_ANCHOR_APPROVED=true \
  -e VNS_FEED_TRUST_POLICY_APPROVED=true \
  -e VNS_FEED_TRUST_POLICY_REVISION=1 \
  -e VNS_FEED_SOURCE_BOOTSTRAP=false \
  -e VNS_FEED_CANARY_SOURCE_ID=noaa_news \
  -e VNS_FEED_CANARY_OPERATOR_ACK=NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY \
  -e VNS_FEED_NASA_512K_ENABLED=false \
  -e VNS_FEED_POLL_STAGE_DIAGNOSTICS=true \
  -e VNS_SOURCE_FETCH_ENABLED=true \
  -e VNS_ALLOWED_SOURCE_HOSTS=www.nasa.gov,www.noaa.gov,www.usgs.gov \
  -e VNS_FEED_QUEUE_NAME=vns-feed-poll \
  -e VNS_FEED_REGISTRY_FILE=/run/secrets/reviewed_research_sources.json \
  -e VNS_FEED_SIGNED_SOURCE_INBOX=/var/lib/vns/feed-source-inbox \
  -e VNS_FEED_SOURCE_CHECKPOINT_DIR=/var/lib/vns/feed-source-checkpoint \
  -e VNS_FEED_SOURCE_PUBLIC_KEY_FILE=/run/secrets/vns_feed_source_public_key \
  -e VNS_FEED_SOURCE_ANCHOR_PASSWORD_FILE=/run/secrets/vns_feed_source_anchor_password \
  -e VNS_FEED_SOURCE_ANCHOR_CA_FILE=/run/secrets/vns_feed_source_anchor_ca \
  -e VNS_FEED_DB_PASSWORD_FILE=/run/secrets/vns_feed_db_password \
  -e VNS_FEED_REDIS_PASSWORD_FILE=/run/secrets/vns_feed_redis_password \
  -e VNS_FEED_OBSERVER_PRODUCER_REDIS_PASSWORD_FILE=/run/secrets/vns_feed_producer_redis_password \
  -e VNS_FEED_DB_HOST=postgres \
  -e VNS_FEED_DB_USER=vns_feed_login_prod \
  -e VNS_FEED_REDIS_HOST=redis \
  -e VNS_FEED_REDIS_USER=vns_feed_consumer_prod \
  -e VNS_FEED_PRODUCER_REDIS_USER=vns_feed_producer_prod \
  -e VNS_FEED_SOURCE_ANCHOR_HOST=postgres \
  -e VNS_FEED_SOURCE_ANCHOR_USER=vns_anchor_login_prod \
  -e VNS_FEED_ANCHOR_PLACEMENT=same_vps \
  -e VNS_FEED_SAME_VPS_RISK_ACK=ACCEPT_SHARED_POSTGRES_AND_RESTORE_DOMAIN \
  "$IMAGE_ID" node apps/worker/dist/feed-observe-once.js --once >/dev/null

docker network connect "$EGRESS" "$CONTAINER"
NETWORKS="$(docker inspect "$CONTAINER" \
  --format '{{if and (index .NetworkSettings.Networks "videonews-studio_backend") (index .NetworkSettings.Networks "videonews-studio_feed_egress")}}READY{{end}}')" || refuse
test "$NETWORKS" = "READY" || refuse

echo "=== EINMALIGER START: NOAA-ONLY, MAX. 128 KIB / 20 KANDIDATEN ==="
# Never run Docker start for this fixed container name again, including after
# a timeout/error/zero candidates. The existing observer sanitizes logs.
set +e
docker start --attach "$CONTAINER"
START_STATUS="$?"
set -e
STATE="$(docker inspect "$CONTAINER" --format '{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}')" || refuse
echo "NOAA_CONTAINER_STATE=$STATE"
if test "$START_STATUS" != "0" || test "$STATE" != "exited|0|0"; then
  echo "STOP: NOAA one-shot incomplete/failed. Preserve container, lease, queue; no retry." >&2
  exit 3
fi
echo "PASS: One-shot container exited 0; audit container intentionally retained"
echo "INFO: This is not proof of fresh candidates, projection, ranking or publication"
