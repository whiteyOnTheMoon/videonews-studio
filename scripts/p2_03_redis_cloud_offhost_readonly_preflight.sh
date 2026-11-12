#!/usr/bin/env bash
# P2-03: only read Git, Docker metadata and local tool presence.
# No network/cloud requests; no Redis commands, files, credentials, or backups.
set -euo pipefail

fail() { echo "REFUSED: read-only Redis off-host backup preflight" >&2; exit 1; }

[[ $# -eq 1 && "$1" =~ ^[a-f0-9]{40}$ ]] || fail
EXPECTED_SHA="$1"
ROOT="/home/ap/www/videonews-studio"
PROD="videonews-studio-redis-1"
IMG="redis:8.4.8-alpine@sha256:d78b2cc0b2433837395263cb86d5ce3830f492201525b0fd148496706fc8fe8c"
VOLUME="videonews-studio_redis_p109_restored"

echo "=== 1. Read-only source checkout ==="
[[ "$(id -un)" == ap && "$(id -u)" == 1000 ]] || fail
cd "$ROOT" || fail
[[ "$(git --no-optional-locks branch --show-current)" == main ]] || fail
[[ "$(git --no-optional-locks rev-parse HEAD)" == "$EXPECTED_SHA" ]] || fail
[[ -z "$(git --no-optional-locks status --porcelain)" ]] || fail
echo "SOURCE_GIT_VERIFIED=true"

echo "=== 2. Redis container identity/state and /data mount ==="
STATE="$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}|{{.State.Health.Status}}' "$PROD")"
[[ "$STATE" == "true|false|healthy" ]] || fail
IMAGE_REF="$(docker inspect --format '{{.Config.Image}}' "$PROD")"
[[ "$IMAGE_REF" == "$IMG" ]] || fail
MOUNT="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}|{{.Name}}|{{.RW}}{{end}}{{end}}' "$PROD")"
[[ "$MOUNT" == "volume|$VOLUME|true" ]] || fail
echo "PRODUCTION_REDIS_HEALTHY=true"
echo "PRODUCTION_DATA_SOURCE_PINNED=true"

echo "=== 3. Local tooling (presence only) ==="
for TOOL in restic rclone docker python3 openssl; do
  if command -v "$TOOL" >/dev/null 2>&1; then
    echo "TOOL_$TOOL=available"
  else
    echo "TOOL_$TOOL=missing"
  fi
done

echo "=== 4. Security boundary ==="
echo "CLOUD_PROVIDER_CONFIGURED=unverified"
echo "CLOUD_CREDENTIALS_VERIFIED=false"
echo "ENCRYPTION_KEY_CUSTODY_VERIFIED=false"
echo "SOURCE_SNAPSHOT_CONSISTENCY_VERIFIED=false"
echo "RESTORE_VERIFIED=false"
echo "PRODUCTION_BACKUP_AUTHORIZED=false"
echo "PRODUCTION_REDIS_PAUSE_AUTHORIZED=false"
echo "READ_ONLY=true"
echo "NETWORK_REQUESTS_SENT=false"
echo "DOCKER_MODIFIED=false"
echo "REDIS_MODIFIED=false"
echo "BACKUP_CREATED=false"
echo "RESTORE_STARTED=false"
echo "PASS: metadata-only cloud backup readiness inventory"
