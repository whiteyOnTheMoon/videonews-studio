# P1-07 — Authenticated Redis runtime preflight

**State:** operator already confirmed healthy, isolated PostgreSQL 17 and Redis 7 containers and migration versions 0001–0011 on the VPS. Redis denies anonymous PING, but successful authentication as the named `vns_worker` account has not yet been demonstrated on live Redis.

This step is **read-only** and makes no Redis key changes or container changes. It is not a worker start. The operator approved P1-07 implementation without backups; no off-site restore is possible or implied.

## What the guarded check verifies

`scripts/p1_07_redis_auth_preflight.py` uses only the standard Python library and Docker CLI. It refuses any host-published Redis port, wrong Docker Compose project/service labels, unhealthy Redis, a nonexclusive backend network, unsafe secret-file modes or a password that does not match the hash and ACL restrictions in `secrets/redis_acl`.

The worker password is read from the existing ignored, local `secrets/redis_password` file and passed to `redis-cli` **through standard input** of an `docker exec -i` client — never through a CLI argument, Docker environment variable, shell history or output. The script requires successful named-user `AUTH` and `PING`, read-only `EXISTS` in the permitted BullMQ namespace, and `NOPERM` on a read-only `EXISTS` outside that namespace. It does not use dangerous ACL test commands like `FLUSHALL`.

## Operator execution after latest-head CI

```bash
cd /home/ap/www/videonews-studio || exit 1
git status --short
git pull --ff-only origin main
python3 scripts/p1_07_redis_auth_preflight.py
```

Only run on the already verified VPS. Return the three `PASS` lines or a sanitized `REFUSED` line. **Do not share `secrets/` contents, password hashes, Docker exec environment, URLs containing credentials or raw container logs.** A refusal is a stop condition; do not overwrite secrets, reset ACL, restart Redis or delete volumes. Existing web/API/Cloudflare/worker remain unchanged.

After live authentication succeeds, separately evaluate whether a suitably pinned worker image already exists. The runnable worker remains **probe-only**, processes no research/render/upload, and has no production approval simply from this Redis check. PostgreSQL/Redis backup-recovery gates remain false under the operator's explicit experimental/no-backup decision.
