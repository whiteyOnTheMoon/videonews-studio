#!/usr/bin/env bash
# P4-11 candidate-only build from isolated preview worktree; no deploy, merge or image publication.
set -Eeuo pipefail
umask 077
refuse() { echo "REFUSED: bounded local image build unsafe" >&2; exit 2; }
[[ $# -eq 2 && "$1" == "--expected-sha" ]] || refuse
SHA="$2"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || refuse
cd /home/ap/videonews-pilot-481 || refuse
MAIN_PATH=/home/ap/www/videonews-studio
[[ "$(git -C "$MAIN_PATH" branch --show-current)" == main ]] || refuse
[[ -z "$(git -C "$MAIN_PATH" --no-optional-locks status --porcelain)" ]] || refuse
MAIN_SHA="$(git -C "$MAIN_PATH" rev-parse HEAD)" || refuse
[[ "$(id -un)" == ap && "$(id -u)" == 1000 ]] || refuse
[[ -z "$(git branch --show-current)" ]] || refuse
[[ "$(git rev-parse HEAD)" == "$SHA" ]] || refuse
[[ -z "$(git --no-optional-locks status --porcelain)" ]] || refuse
INDEX_PATH="$(git rev-parse --git-path index)" || refuse
[[ "$(stat -c '%u:%g:%a:%h:%F' "$INDEX_PATH")" == '1000:1000:600:1:regular file' ]] || refuse
[[ "$(docker info --format '{{.CgroupVersion}}')" == 2 ]] || refuse
SHORT="$(printf '%.12s' "$SHA")"
BUILDER="vns-p411-$SHORT"
BUILDER_CONTAINER="$(printf 'buildx_buildkit_%s0' "$BUILDER")"
API="vns-api:internal-$SHORT"
WEB="vns-web:internal-$SHORT"
SERVICES="videonews-studio-web-1 videonews-studio-api-1 videonews-studio-postgres-1 videonews-studio-redis-1 videonews-studio-worker-1"
CREATED=false
CONF_DIR=""
cleanup() {
  code=$?
  trap - EXIT
  if [[ "$CREATED" == true ]]; then
    docker buildx rm --force "$BUILDER" >/dev/null 2>&1 ||
      echo "WARNING: inspect dedicated builder only" >&2
  fi
  if [[ -n "$CONF_DIR" ]]; then
    rm -f -- "$CONF_DIR/buildkitd.toml"
    rmdir -- "$CONF_DIR" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT
resources() {
  local disk mem swap
  disk="$(df -Pk /var/lib/docker | awk 'NR==2 {print $4}')"
  mem="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  swap="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)"
  [[ "$disk" =~ ^[0-9]+$ && "$mem" =~ ^[0-9]+$ && "$swap" =~ ^[0-9]+$ ]] || refuse
  echo "FREE disk=$((disk/1024))MiB RAM=$((mem/1024))MiB swap=$((swap/1024))MiB"
  (( disk >= 16*1024*1024 && mem >= 3500*1024 && swap >= 256*1024 )) || refuse
}
echo '=== 1. UNCHANGED CONTAINERS ==='
for service in $SERVICES; do
  [[ "$(docker inspect --format '{{.State.Status}}' "$service")" == running ]] || refuse
done
for service in web api postgres; do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "videonews-studio-$service-1")" == healthy ]] || refuse
done
BEFORE="$(docker inspect --format '{{.Id}}|{{.State.StartedAt}}' $SERVICES)" || refuse
docker buildx version >/dev/null || refuse
! docker buildx inspect "$BUILDER" >/dev/null 2>&1 || refuse
! docker image inspect "$API" >/dev/null 2>&1 || refuse
! docker image inspect "$WEB" >/dev/null 2>&1 || refuse
[[ -z "$(docker ps -aq --filter "name=^/$BUILDER_CONTAINER$")" ]] || refuse
resources
echo '=== 2. 2048 MiB BUILDKIT, NO SWAP, ONE PARALLEL STEP ==='
CONF_DIR="$(mktemp -d -t vns-buildkit.XXXXXXXX)" || refuse
printf '[worker.oci]\n  max-parallelism = 1\n' > "$CONF_DIR/buildkitd.toml"
docker buildx create --name "$BUILDER" --driver docker-container \
  --driver-opt 'memory=2048m,memory-swap=2048m,restart-policy=no' \
  --buildkitd-config "$CONF_DIR/buildkitd.toml" >/dev/null || refuse
CREATED=true
docker buildx inspect "$BUILDER" --bootstrap >/dev/null || refuse
[[ "$(docker inspect --format '{{.HostConfig.Memory}}|{{.HostConfig.MemorySwap}}|{{.HostConfig.RestartPolicy.Name}}' "$BUILDER_CONTAINER")" == '2147483648|2147483648|no' ]] || refuse
PORTS="$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$BUILDER_CONTAINER")" || refuse
[[ "$PORTS" == null || "$PORTS" == '{}' ]] || refuse
echo '=== 3. BUILD AND LOAD API, THEN WEB LOCALLY ==='
for target in api web; do
  resources
  if [[ "$target" == api ]]; then image="$API"; else image="$WEB"; fi
  docker buildx build --builder "$BUILDER" --platform linux/amd64 \
    --target "$target" --file Dockerfile \
    --label "org.opencontainers.image.revision=$SHA" \
    --tag "$image" --load --progress plain . || refuse
  [[ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$SHA" ]] || refuse
  echo "PASS: $target image built locally"
done
echo '=== 4. NO SERVICES CHANGED ==='
[[ "$(git -C "$MAIN_PATH" rev-parse HEAD)" == "$MAIN_SHA" ]] || refuse
[[ "$(git -C "$MAIN_PATH" branch --show-current)" == main ]] || refuse
[[ -z "$(git -C "$MAIN_PATH" --no-optional-locks status --porcelain)" ]] || refuse
[[ "$(docker inspect --format '{{.Id}}|{{.State.StartedAt}}' $SERVICES)" == "$BEFORE" ]] || refuse
[[ "$(git rev-parse HEAD)" == "$SHA" ]] || refuse
[[ -z "$(git --no-optional-locks status --porcelain)" ]] || refuse
echo "PASS: candidate images ready; no deployment, merge, upload or editorial publication"
echo "API_IMAGE=$API"
echo "WEB_IMAGE=$WEB"
