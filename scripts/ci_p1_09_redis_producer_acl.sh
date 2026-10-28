#!/usr/bin/env bash
# Disposable GitHub Actions synthetic ACL validation: NO VPS/production network.
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true ||       "${GITHUB_REPOSITORY:-}" != whiteyOnTheMoon/videonews-studio ||       ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]]; then
  echo "REFUSED: synthetic GitHub Actions only" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
tmp="$(mktemp -d /tmp/vns-p109-redis-producer-XXXXXXXX)"
name="vns-p109-redis-producer-${GITHUB_RUN_ID:?}"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
export VNS_P109_SYNTHETIC_ACL_DIR="$tmp"
python3 - <<'PY'
import hashlib
import os
from pathlib import Path
from unittest.mock import patch
import secrets
import sys
sys.path.insert(0, "scripts")
import p1_09_redis_producer_acl_rollout as rollout
from p1_09_provider_outbox_custody import acl_line
root = Path(os.environ["VNS_P109_SYNTHETIC_ACL_DIR"])
folder = root / "secrets"
private = folder / "vns-outbox"
folder.mkdir(mode=0o700)
private.mkdir(mode=0o700)
worker, producer = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
(folder / "worker_password").write_text(worker + "\n", encoding="ascii")
(private / "provider-outbox-redis-password").write_text(producer + "\n", encoding="ascii")
(private / "provider-outbox-acl-candidate").write_text(acl_line(producer), encoding="ascii")
original = (
    "user default off\n"
    "user vns_worker on #" + hashlib.sha256(worker.encode()).hexdigest()
    + " ~bull:vns:* +@all -@admin -@dangerous +info\n"
)
(folder / "redis_acl").write_text(original, encoding="ascii")
for p in (private / "provider-outbox-redis-password", private / "provider-outbox-acl-candidate", folder / "worker_password"):
    p.chmod(0o600)
(folder / "redis_acl").chmod(0o644)
with patch.object(rollout, "SECRETS", folder), patch.object(rollout, "PRIVATE", private), patch.object(rollout, "operator"):
    rollout.preflight()
    rollout.prepare()
    rollout.verify()
    rollout.install_file()
    rollout.installed()
assert "user default off" in (folder / "redis_acl").read_text("ascii")
assert (private / rollout.BACKUP).read_text("ascii") == original
PY
docker run -d --rm --name "$name" --network none   --memory 144m --memory-swap 144m --cpus 0.3 --pids-limit 64   --mount "type=bind,src=$tmp/secrets/redis_acl,dst=/run/secrets/redis_acl,readonly"   redis:7-alpine redis-server --save "" --appendonly no   --protected-mode yes --aclfile /run/secrets/redis_acl >/dev/null
ready=0
for i in $(seq 1 40); do
  if docker exec "$name" redis-cli ping 2>&1 | grep -q NOAUTH; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
worker_password="$(cat "$tmp/secrets/worker_password")"
producer_password="$(cat "$tmp/secrets/vns-outbox/provider-outbox-redis-password")"
worker_login="$(docker exec -e REDISCLI_AUTH="$worker_password"   "$name" redis-cli --user vns_worker ping)"
test "$worker_login" = PONG
producer_login="$(docker exec -e REDISCLI_AUTH="$producer_password"   "$name" redis-cli --user vns_provider_producer ping)"
test "$producer_login" = PONG
identity="$(docker exec -e REDISCLI_AUTH="$producer_password"   "$name" redis-cli --user vns_provider_producer ACL WHOAMI)"
test "$identity" = vns_provider_producer
allowed="$(docker exec -e REDISCLI_AUTH="$producer_password"   "$name" redis-cli --user vns_provider_producer   SET bull:vns:vns-provider-text:ci-only 1)"
test "$allowed" = OK
denied="$(docker exec -e REDISCLI_AUTH="$producer_password"   "$name" redis-cli --user vns_provider_producer   SET bull:vns:vns-jobs:ci-cross-queue 1 2>&1 || true)"
echo "$denied" | grep -q NOPERM
denied="$(docker exec -e REDISCLI_AUTH="$producer_password"   "$name" redis-cli --user vns_provider_producer FLUSHALL 2>&1 || true)"
echo "$denied" | grep -q NOPERM
denied="$(docker exec -e REDISCLI_AUTH="$worker_password"   "$name" redis-cli --user vns_worker ACL SETUSER attacker on 2>&1 || true)"
echo "$denied" | grep -q NOPERM
echo "PASS: original worker retained; producer confined; default off; no admin or cross-queue"
