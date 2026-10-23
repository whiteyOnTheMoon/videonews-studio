#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true ]]; then
  echo "REFUSED: disposable GitHub Actions only" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="vns-worker-test-${GITHUB_RUN_ID:?}"
tmp="$(mktemp -d)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
python3 "$root/scripts/provision_redis_secrets.py" "$tmp" >/dev/null
docker run --rm -d --name "$name" \
  --network bridge -p 127.0.0.1:16379:6379 \
  --memory 144m --memory-swap 144m --cpus 0.5 --pids-limit 64 \
  --mount "type=bind,src=$tmp/redis_acl,dst=/run/secrets/redis_acl,readonly" \
  redis:7-alpine redis-server --protected-mode yes --bind 0.0.0.0 \
  --aclfile /run/secrets/redis_acl --appendonly no --save "" >/dev/null
for i in $(seq 1 30); do
  if docker exec "$name" redis-cli ping 2>&1 | grep -q NOAUTH; then break; fi
  sleep 1
done
export VNS_TEST_REDIS_PASSWORD_FILE="$tmp/redis_password"
node "$root/scripts/test_worker_integration.mjs"
node "$root/scripts/test_worker_recovery.mjs"
