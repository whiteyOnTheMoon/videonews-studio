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
bootstrap="vns-ci-aof-bootstrap-${GITHUB_RUN_ID}"
umask 077
tmp="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" "$bootstrap" "$target" >/dev/null 2>&1 || true
  rm -rf -- "$tmp"
}
trap cleanup EXIT
mkdir -m 0700 "$tmp/source" "$tmp/restored" "$tmp/tampered"
python3 "$root/scripts/provision_redis_secrets.py" "$tmp" >/dev/null
export VNS_TEST_REDIS_PASSWORD_FILE="$tmp/redis_password"
export VNS_CI_AOF_DRILL=true

# Redis AOF replay may need a temporary recovery ACL; this mode has NO
# network or host ports. Normal containers retain the restrictive ACL.
start() {
  local container="$1" volume="$2" mode="$3"
  local acl_file="$tmp/redis_acl" expected="NOAUTH"
  local network=(--network bridge -p 127.0.0.1:16380:6379)
  if [[ "$mode" == "offline-replay" ]]; then
    acl_file="$tmp/ci_recovery_acl"
    expected="PONG"
    network=(--network none)
  elif [[ "$mode" != "strict" ]]; then
    echo "FAIL: unrecognized Redis recovery mode" >&2
    exit 1
  fi
  docker run --rm --detach --name "$container" \
    --user "$(id -u):$(id -g)" \
    "${network[@]}" \
    --memory 160m --memory-swap 160m --cpus 0.5 --pids-limit 80 \
    --mount "type=bind,src=$volume,dst=/data" \
    --mount "type=bind,src=$acl_file,dst=/run/secrets/redis_acl,readonly" \
    redis:7-alpine redis-server --protected-mode yes --bind 0.0.0.0 \
    --aclfile /run/secrets/redis_acl --appendonly yes \
    --appendfsync always --aof-load-truncated no --save "" --dir /data >/dev/null
  local ready=0
  for i in $(seq 1 45); do
    if docker exec "$container" redis-cli ping 2>&1 | grep -q "$expected"; then
      ready=1
      break
    fi
    sleep 1
  done
  test "$ready" -eq 1 || { echo "FAIL: Redis AOF instance not ready" >&2; exit 1; }
}

echo "P1-07 disposable Redis AOF source with no worker processes"
start "$name" "$tmp/source" strict
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
# Redis 7 AOF loading can reject MULTI/EXEC with NOPERM when default
# ACL is off, yet still start with an empty queue. Bootstrap a VERIFIED
# archive in a networkless, workerless process with one-time recovery ACL,
# compact to an RDB-base AOF, then restart with original restricted ACL.
printf 'user default on nopass +@all\n' > "$tmp/ci_recovery_acl"
chmod 0600 "$tmp/ci_recovery_acl"
start "$bootstrap" "$tmp/restored" offline-replay
dbsize="$(docker exec "$bootstrap" redis-cli DBSIZE | tr -d '\r')"
if ! [[ "$dbsize" =~ ^[0-9]+$ ]] || (( dbsize < 4 )); then
  echo "FAIL: isolated Redis bootstrap did not recover synthetic keys" >&2
  docker logs --tail 70 "$bootstrap" 2>&1
  exit 1
fi
docker exec "$bootstrap" redis-cli BGREWRITEAOF | grep -q 'Background append only file rewriting started'
rewritten=0
for i in $(seq 1 60); do
  info="$(docker exec "$bootstrap" redis-cli INFO persistence)"
  if grep -q 'aof_rewrite_in_progress:0' <<< "$info" &&
     grep -q 'aof_last_bgrewrite_status:ok' <<< "$info"; then
    rewritten=1
    break
  fi
  sleep 1
done
test "$rewritten" -eq 1 || { echo "FAIL: recovery AOF rewrite incomplete" >&2; exit 1; }
docker stop --time 15 "$bootstrap" >/dev/null

# Validate in a fresh process with no permissive ACL and loopback-only port.
start "$target" "$tmp/restored" strict
node "$root/scripts/test_ci_redis_aof_restore.mjs" verify
echo "PASS: Redis AOF recovered in networkless bootstrap with strict-ACL restart"
echo "LIMIT: CI-only rewrite is NOT a production backup or approval"
