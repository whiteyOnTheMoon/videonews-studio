#!/usr/bin/env bash
# Tests auth with a disposable, network-isolated Redis instance on GitHub Actions.
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true ]]; then
  echo "REFUSED: GitHub Actions only" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="vns-redis-acl-test-${GITHUB_RUN_ID:?}"
tmp="$(mktemp -d)"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

python3 "$root/scripts/provision_redis_secrets.py" "$tmp" >/dev/null
# Disposable local CI credential; never a VPS secret.
password="$(cat "$tmp/redis_password")"
docker run --rm -d --name "$name" \
  --network none --memory 144m --memory-swap 144m \
  --cpus 0.4 --pids-limit 64 \
  --mount "type=bind,src=$tmp/redis_acl,dst=/run/secrets/redis_acl,readonly" \
  redis:7-alpine redis-server --save "" --appendonly no \
  --protected-mode yes --aclfile /run/secrets/redis_acl >/dev/null

for i in $(seq 1 30); do
  if docker exec "$name" redis-cli ping 2>&1 | grep -q NOAUTH; then break; fi
  sleep 1
done

if ! docker exec "$name" redis-cli ping 2>&1 | grep -q NOAUTH; then
  echo "FAIL: unauthenticated ping not rejected" >&2
  exit 1
fi

result="$(docker exec -e REDISCLI_AUTH="$password" "$name" \
  redis-cli --user vns_worker ping)"
test "$result" = PONG || { echo "FAIL: ACL-authenticated ping"; exit 1; }

# ACL must deny administrative commands and cross-namespace access.
result="$(docker exec -e REDISCLI_AUTH="$password" "$name" \
  redis-cli --user vns_worker FLUSHALL 2>&1 || true)"
echo "$result" | grep -q NOPERM || { echo "FAIL: dangerous command allowed"; exit 1; }

result="$(docker exec -e REDISCLI_AUTH="$password" "$name" \
  redis-cli --user vns_worker SET other-key sample 2>&1 || true)"
echo "$result" | grep -q NOPERM || { echo "FAIL: cross-namespace write allowed"; exit 1; }

result="$(docker exec -e REDISCLI_AUTH="$password" "$name" \
  redis-cli --user vns_worker SET bull:vns:test:key sample)"
test "$result" = OK || { echo "FAIL: valid namespace write"; exit 1; }

echo "PASS: default user disabled, authenticated worker, ACL namespace and command isolation"
