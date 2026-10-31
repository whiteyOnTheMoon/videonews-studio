#!/usr/bin/env bash
# Disposable synthetic Redis verification. NEVER touches a VPS or installed Redis.
set -Eeuo pipefail
if [[ "$GITHUB_ACTIONS" != true || "$CI" != true ||
      "$GITHUB_REPOSITORY" != whiteyOnTheMoon/videonews-studio ||
      ! "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "REFUSED: synthetic GitHub Actions only" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
tmp="$(mktemp -d /tmp/vns-p202-feed-acl-XXXXXXXX)"
name="vns-p202-feed-acl-$GITHUB_RUN_ID"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
export VNS_P202_CI_ACL_DIR="$tmp"
python3 - <<'PY'
import hashlib
import os
from pathlib import Path
from unittest.mock import patch
import secrets
import sys
sys.path.insert(0, "scripts")
import p2_02_feed_redis_acl_custody as acl
root = Path(os.environ["VNS_P202_CI_ACL_DIR"])
folder = root / "secrets"
folder.mkdir(mode=0o700)
folder.chmod(0o700)
worker, provider = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
(folder / "worker_password").write_text(worker + "\n")
(folder / "provider_password").write_text(provider + "\n")
original = (
    "user default off\n"
    f"user vns_worker on #{hashlib.sha256(worker.encode()).hexdigest()} "
    "~bull:vns:* +@all -@admin -@dangerous +info\n"
    f"user vns_provider_producer on #{hashlib.sha256(provider.encode()).hexdigest()} "
    "resetkeys ~bull:vns:vns-provider-text:* resetchannels "
    "&bull:vns:vns-provider-text:* +@all -@dangerous +info +acl|whoami\n"
)
(folder / "redis_acl").write_text(original)
(folder / "redis_acl").chmod(0o644)
native_dir = acl.private_directory
with (patch.object(acl, "SECRETS", folder),
      patch.object(acl, "PRIVATE", folder / "p2-feed-redis-acl"),
      patch.object(acl, "operator"),
      patch.object(acl, "private_directory",
                   side_effect=lambda p: native_dir(p, expected_uid=os.geteuid()))):
    acl.stage("a"*40)
    acl.preflight("a"*40)
    acl.prepare("a"*40)
    acl.verify("a"*40)
    acl.install_file("a"*40)
    acl.installed("a"*40)
assert (folder / "p2-feed-redis-acl" / acl.BACKUP).read_text() == original
PY
docker run -d --rm --name "$name" --network none \
  --memory 144m --memory-swap 144m --cpus 0.3 --pids-limit 64 \
  --mount "type=bind,src=$tmp/secrets/redis_acl,dst=/run/secrets/redis_acl,readonly" \
  redis:7-alpine redis-server --save "" --appendonly no \
  --protected-mode yes --aclfile /run/secrets/redis_acl >/dev/null
ready=0
for i in $(seq 1 40); do
  if docker exec "$name" redis-cli ping 2>&1 | grep -q NOAUTH; then
    ready=1
    break
  fi
  sleep 1
done
test "$ready" = 1
python3 - "$name" <<'PY'
import os
import subprocess
import sys
from pathlib import Path

container = sys.argv[1]
root = Path(os.environ["VNS_P202_CI_ACL_DIR"]) / "secrets"

def check(user, password_file, allowed_key, denied_key):
    password = password_file.read_text("ascii").strip()
    # AUTH provided only over stdin (never CLI args or Docker environment).
    commands = (
        f"AUTH {user} {password}\nPING\n"
        f"SET {allowed_key} test\n"
        f"SET {denied_key} forbidden\n"
        "ACL SETUSER attacker on\nFLUSHALL\nQUIT\n"
    )
    r = subprocess.run(
        ["docker", "exec", "-i", container, "redis-cli", "--raw"],
        input=commands, capture_output=True, text=True, timeout=12, check=False,
    )
    if r.returncode != 0:
        raise RuntimeError("Redis ACL authentication failed")
    lines = r.stdout.strip().splitlines()
    if not (len(lines) >= 6 and lines[0:3] == ["OK","PONG","OK"]
            and all("NOPERM" in line for line in lines[3:6])):
        raise RuntimeError("Redis ACL scope not preserved")

check("vns_worker", root / "worker_password",
      "bull:vns:vns-jobs:ci", "bull:vns:feed:vns-feed-poll:ci")
check("vns_provider_producer", root / "provider_password",
      "bull:vns:vns-provider-text:ci", "bull:vns:feed:vns-feed-poll:ci")
for user, name in (
    ("vns_feed_producer_prod", "feed-producer-redis-password"),
    ("vns_feed_consumer_prod", "feed-consumer-redis-password"),
):
    check(user, root / "p2-feed-redis-acl" / name,
          "bull:vns:feed:vns-feed-poll:ci",
          "bull:vns:vns-provider-text:ci")
print("PASS: isolated Redis users and feed-only namespaces validated")
print("PASS: pre-existing worker/provider preserved; cross-queue and admin denied")
PY
