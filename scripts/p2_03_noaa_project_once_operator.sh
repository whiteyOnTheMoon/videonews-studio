#!/usr/bin/env bash
# P2-03: One separate operator-approved NOAA DB-only historical projection.
# Never CI, never automatic. An attempted run is permanently non-retryable.
set -euo pipefail
umask 077

ROOT="/home/ap/www/videonews-studio"
PRE="$ROOT/scripts/p2_03_noaa_projector_readonly_preflight.py"
IMAGE_ID="sha256:0116ba447642645ae81324347ac800fd45991fdf7006676936d7515f285a45ef"
CONTAINER="vns-noaa-project-20261108-a5c73c9"
BACKEND="videonews-studio_backend"
SECRET="/var/lib/videonews-studio/p2-feed-runtime-secrets/vns_feed_project_db_password"
ATTEMPT_DIR="/var/lib/videonews-studio/p2-03-noaa-projection-attempt-20261108-a5c73c9"
ACK="NOAA_HISTORICAL_DB_ONLY_PROJECTION_ONCE_NO_RETRY"
DENIED="REFUSED: P2-03 NOAA one-shot not admitted; preserve all state; no retry"

refuse() { printf '%s\n' "$DENIED" >&2; exit 2; }

case "$#" in
  3)
    test "$1" = "--preflight" && test "$2" = "--expected-sha" || refuse
    ACTION="preflight"
    ;;
  5)
    test "$1" = "--run" && test "$2" = "--expected-sha" \
      && test "$4" = "--approval" && test "$5" = "$ACK" || refuse
    ACTION="run"
    ;;
  *) refuse ;;
esac

SHA="$3"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || refuse
test "$(id -u)" = "0" || refuse

# Even a failed Docker create consumes this one-time authorization:
# the protected, atomic attempt directory cannot already exist.
test ! -e "$ATTEMPT_DIR" && test ! -L "$ATTEMPT_DIR" || refuse
REPORT="$(python3 "$PRE" --preflight --expected-sha "$SHA")" || refuse
printf '%s' "$REPORT" | python3 -c '
import json,sys
r=json.load(sys.stdin)
assert r["status"]=="reviewable_no_write"
assert r["source_id"]=="noaa_news"
assert r["release"]==sys.argv[1]
assert r["image_id"]==sys.argv[2]
assert r["existing_candidates"]==18
assert r["projected_articles"]==10
assert r["selectable_missing"]==8
assert r["missing_age_eligible"]==0
assert r["database_changed"] is False
assert r["container_created"] is False
assert r["projection_authorized"] is False
assert r["publication_authorized"] is False
' "$SHA" "$IMAGE_ID" >/dev/null 2>&1 || refuse

if test "$ACTION" = "preflight"; then
  printf '%s\n' "$REPORT"
  echo "INFO: Read-only; no container, attempt marker, SQL write or feed request"
  exit 0
fi

# From here on, ONLY an explicit, narrow, one-time operator write approval
# permits mutation. Create the atomic attempt marker BEFORE Docker create.
# If create/start/execution fails, marker and container remain for audit;
# never remove, rename, recreate or start this project attempt again.
mkdir -m 0700 -- "$ATTEMPT_DIR" || refuse
printf 'release=%s\nimage_id=%s\nscope=noaa_news_db_only_8_historical_candidates\n' \
  "$SHA" "$IMAGE_ID" > "$ATTEMPT_DIR/attempt.txt"
chmod 0600 "$ATTEMPT_DIR/attempt.txt"

echo "=== ONE ATTEMPT RESERVED: NOAA DB-ONLY PROJECTOR ==="
docker create \
  --name "$CONTAINER" \
  --pull never \
  --init \
  --restart no \
  --read-only \
  --user 10004:10004 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 48 \
  --memory 192m \
  --memory-swap 192m \
  --cpus 0.25 \
  --tmpfs /tmp:rw,nosuid,noexec,size=8m \
  --network "$BACKEND" \
  --label vns.audit.scope=noaa_historical_db_projection_once \
  --mount "type=bind,source=$SECRET,target=/run/secrets/vns_feed_project_db_password,readonly" \
  -e NODE_ENV=production \
  -e VNS_P2_FEED_PROJECTION_ENABLED=true \
  -e VNS_P2_FEED_PROJECTION_OPERATOR_ACK=true \
  -e VNS_P2_FEED_PROJECTION_MODE=single_pass \
  -e VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP=false \
  -e VNS_P2_FEED_PROJECTION_DB_HOST=postgres \
  -e VNS_P2_FEED_PROJECTION_DB_USER=vns_feed_project_login_prod \
  -e VNS_P2_FEED_PROJECTION_SOURCE_ID=noaa_news \
  -e VNS_P2_FEED_PROJECTION_LIMIT=8 \
  -e VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE=/run/secrets/vns_feed_project_db_password \
  "$IMAGE_ID" node apps/worker/dist/feed-candidate-project-once.js --once \
  >/dev/null

# The backend is Docker-internal, and no egress network or host port is added.
# Start exactly once. A failed start/attach does not permit a second start.
echo "=== ONE DOCKER START: NO HTTP, REDIS, SCHEDULER OR PUBLICATION ==="
set +e
docker start --attach "$CONTAINER"
START_STATUS="$?"
set -e

STATE="$(docker inspect "$CONTAINER" \
  --format '{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}')" || refuse
echo "PROJECTOR_CONTAINER_STATE=$STATE"

if test "$START_STATUS" != "0" || test "$STATE" != "exited|0|0"; then
  echo "STOP: DB-only one-shot did not complete cleanly. Preserve audit state; NO RETRY." >&2
  exit 3
fi

echo "PASS: One DB-only projector process exited successfully; audit retained"
echo "INFO: This is not proof of 8 mappings, ranking, publisher review or publication"
