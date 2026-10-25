#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != true || "${CI:-}" != true || "${GITHUB_REPOSITORY:-}" != whiteyOnTheMoon/videonews-studio || ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]]; then
  echo "REFUSED: GitHub Actions disposable fixture only" >&2
  exit 1
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d /tmp/vns-acl-fixture-XXXXXXXX)"
name="vns-acl-ci-${GITHUB_RUN_ID}"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
python3 - "$root" "$tmp" <<'PY'
import hashlib
from pathlib import Path
import secrets
import sys
sys.path.insert(0, str(Path(sys.argv[1]) / "scripts"))
from research_redis_acl import render_isolated_acl

folder = Path(sys.argv[2])
worker, research = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
(folder / "redis_password").write_text(worker + "\n")
(folder / "research_password").write_text(research + "\n")
(folder / "redis_acl").write_text(render_isolated_acl(
    hashlib.sha256(worker.encode()).hexdigest(),
    hashlib.sha256(research.encode()).hexdigest(),
))
for file in folder.iterdir():
    file.chmod(0o600 if file.name != "redis_acl" else 0o644)
PY
docker run --rm -d --name "$name" \
  --network bridge -p 127.0.0.1:16381:6379 \
  --memory 144m --memory-swap 144m --cpus 0.5 --pids-limit 64 \
  --mount "type=bind,src=$tmp/redis_acl,dst=/run/secrets/redis_acl,readonly" \
  redis:7-alpine redis-server --protected-mode yes --bind 0.0.0.0 \
  --aclfile /run/secrets/redis_acl --appendonly no --save "" >/dev/null
ready=0
for i in $(seq 1 30); do
  if docker exec "$name" redis-cli ping 2>&1 | grep -q NOAUTH; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1 || { echo "Disposable Redis unavailable" >&2; exit 1; }
export VNS_CI_ACL_DIRECTORY="$tmp"
node "$root/scripts/test_research_redis_acl_integration.mjs"
