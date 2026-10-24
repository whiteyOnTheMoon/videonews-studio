#!/usr/bin/env bash
# P1-07 GitHub Actions-only Redis 7 multipart AOF restore to a clean container.
# No VPS, no live secrets, no workers, no service profile changes.
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != "true" ||
      "${CI:-}" != "true" ||
      "${GITHUB_REPOSITORY:-}" != "whiteyOnTheMoon/videonews-studio" ||
      ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]]; then
  echo "REFUSED: GitHub Actions CI only" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="vns-ci-aof-src-${GITHUB_RUN_ID}"
target="vns-ci-aof-dst-${GITHUB_RUN_ID}"
umask 077
tmp="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" "$target" >/dev/null 2>&1 || true
  rm -rf -- "$tmp"
}
trap cleanup EXIT
mkdir -m 0700 "$tmp/source" "$tmp/restored" "$tmp/tampered"
python3 "$root/scripts/provision_redis_secrets.py" "$tmp" >/dev/null
export VNS_TEST_REDIS_PASSWORD_FILE="$tmp/redis_password"
export VNS_CI_AOF_DRILL=true

start() {
  local container="$1" volume="$2"
  # Match the CI runner UID/GID so the Redis entrypoint cannot chown
  # the private runner-side AOF directory away from the verifier.
  docker run --rm --detach --name "$container" \
    --user "$(id -u):$(id -g)" \
    --network bridge -p 127.0.0.1:16380:6379 \
    --memory 160m --memory-swap 160m --cpus 0.5 --pids-limit 80 \
    --mount "type=bind,src=$volume,dst=/data" \
    --mount "type=bind,src=$tmp/redis_acl,dst=/run/secrets/redis_acl,readonly" \
    redis:7-alpine redis-server --protected-mode yes --bind 0.0.0.0 \
    --aclfile /run/secrets/redis_acl --appendonly yes \
    --appendfsync always --aof-load-truncated no --save "" --dir /data >/dev/null
  local ready=0
  for i in $(seq 1 45); do
    if docker exec "$container" redis-cli ping 2>&1 | grep -q NOAUTH; then
      ready=1
      break
    fi
    sleep 1
  done
  test "$ready" -eq 1 || { echo "FAIL: Redis AOF instance not ready" >&2; exit 1; }
}

echo "P1-07 disposable Redis AOF source with no worker processes"
start "$name" "$tmp/source"
node "$root/scripts/test_ci_redis_aof_restore.mjs" seed
docker stop --time 15 "$name" >/dev/null

# Redis 7 uses multipart AOF (manifest + base/incremental data files).
# Work only with a stopped source, never a live changing AOF directory.
(
  cd "$tmp/source"
  find . -type f -print0 | sort -z | xargs -0 sha256sum
) > "$tmp/aof.sha256"
test -s "$tmp/aof.sha256"
grep -q '\.aof' "$tmp/aof.sha256" || {
  echo "FAIL: no append-only recovery data found" >&2
  exit 1
}
(cd "$tmp/source" && sha256sum --check --status "$tmp/aof.sha256")

# Copy both the multipart manifest and segments to an independent clean dir.
cp -a "$tmp/source/." "$tmp/restored/"
(cd "$tmp/restored" && sha256sum --check --status "$tmp/aof.sha256")

# A changed archived AOF segment must be refused BEFORE Redis is started.
cp -a "$tmp/source/." "$tmp/tampered/"
aof_file="$(find "$tmp/tampered" -type f -name '*.aof' -print -quit)"
test -n "$aof_file"
printf 'synthetic-corruption' >> "$aof_file"
if (cd "$tmp/tampered" && sha256sum --check --status "$tmp/aof.sha256"); then
  echo "FAIL: corrupted AOF passed checksum comparison" >&2
  exit 1
fi
echo "PASS: multipart AOF checksum verification rejects tampering"
echo "CI-AOF-DIAG: synthetic archived file sizes:"
find "$tmp/source" -type f -printf '%P %s bytes\\n'

# The actual restore uses a NEW Redis process and separate restored files.
start "$target" "$tmp/restored"
echo "CI-AOF-DIAG: restored Redis startup log (synthetic data only):"
docker logs --tail 45 "$target" 2>&1
echo "CI-AOF-DIAG: Redis 7 multipart AOF manifest:"
cat "$tmp/restored/appendonlydir/appendonly.aof.manifest"
node "$root/scripts/test_ci_redis_aof_restore.mjs" verify
echo "PASS: clean disposable Redis 7 multipart AOF recovery verified"
echo "LIMIT: no PostgreSQL atomicity, media, off-host archive or live RPO/RTO proof"
