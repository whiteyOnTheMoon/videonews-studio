# P1-07 — operator-run, probe-only worker canary

**Scope:** An experimental, no-backup trial previously authorized by the operator. Live PostgreSQL 17, Redis 7 and all eleven schema migrations are verified. Live Redis `vns_worker` authentication, private namespace and ACL were separately verified through a **read-only** operator-run test. Existing Web/API/Tunnel must not be rebuilt or restarted for this stage.

## Worker limitation

The runtime in `apps/worker/src/queue.ts` processes only well-formed harmless `probe` jobs. It has **concurrency 1**, does not run research/rendering/upload, and fails closed for other job types. **No editorial jobs may be enqueued as part of this canary.** PostgreSQL outbox/dispatch and status-sync CLIs are separate and are not being activated. A successful running worker does not complete the full editorial-processing pipeline or prove offsite recovery.

## Why the dedicated Dockerfile exists

The legacy `Dockerfile`'s `builder` stage compiles the Next.js app even when its `worker` target is selected. On the shared 7.8 GiB VPS (about 3.1 GiB RAM available, 23 GB disk free at the last reading), this is unnecessary. `Dockerfile.worker` builds only the shared and worker code with the pinned npm lockfile and creates a production-only worker image. It does not change the Web or API Dockerfiles.

The operator script `scripts/p1_07_worker_canary.sh` checks the exact Compose project/service identity, Redis and PostgreSQL health, private network, local Redis credentials and ACL (including a 0600 file owned by UID 1000 for the non-root Node process), unmodified `main` checkout, combined worker-overlay configuration and host resources before building. Live build requires at least 2,400 MiB available RAM, at least 20 GiB free on the root filesystem and less than 85% disk usage. These are **conservative preflight thresholds, not a resource guarantee**. The script refuses an existing worker container and refuses to overwrite an existing `vns-worker:local` image tag. The password file must be owned by UID **1000**, which is the official Node runtime user's UID, while remaining mode **0600**. If the owner differs, the script refuses rather than weakening file permissions or switching the runtime to root; inspect the numeric UID before making any narrowly scoped, operator-reviewed ownership change.

Only `vns-worker:local` is built, labelled with the exact checked-out commit SHA. The start action refuses an image not labelled with the same reviewed commit, uses `--no-deps --no-build --pull never` to start **only** the worker service with the opt-in `deploy/compose.worker.yaml`, and requires an authenticated startup message with concurrency 1. The container is internal-only without published host ports. The runtime's code emits deliberately generic error messages to avoid leaking Redis secrets.

**No backups.** Loss of persisted state or the VPS can permanently erase data. The twelve full-recovery release gates remain false. Neither `stop` nor a rollback of the container image can recover lost PostgreSQL/Redis state.

## Verification before running on the VPS

The new GitHub Actions workflow `P1-07 probe worker canary (disposable)` compiles the dedicated image, starts a disposable ACL-protected Redis, validates the combined Compose overlay, starts the probe worker with concurrency 1, checks its startup, enqueues and awaits completion of one harmless `probe` job **in disposable CI only**, rejects a second create attempt, and stops only the disposable worker. The CI runner's distinct project identifier prevents interaction with any live service. Verify the successful workflow on the **merged head** before VPS use.

## Operator steps (each action stops on refusal)

From a trusted VPS shell:

```bash
cd /home/ap/www/videonews-studio || exit 1
git status --short
git pull --ff-only origin main
bash scripts/p1_07_worker_canary.sh preflight
```

If and only if preflight passes, build the *worker-only* image. Builds can consume CPU, network bandwidth, cache and disk space; monitor the other projects and stop on signs of resource pressure. Do not clear unrelated images or build caches:

```bash
bash scripts/p1_07_worker_canary.sh build
```

Only after a successful build with remaining resource headroom:

```bash
bash scripts/p1_07_worker_canary.sh start
bash scripts/p1_07_worker_canary.sh status
```

For a controlled stop that **preserves PostgreSQL and Redis volumes**:

```bash
bash scripts/p1_07_worker_canary.sh stop
```

A stopped worker container is deliberately not recreated by the script. Investigate or plan a separate targeted restart/rollout instead of deleting the worker or its image automatically. Never use global `docker compose up`, `down -v`, `docker system prune` or bulk delete commands here.

## What to report

Share only `PASS`/`REFUSED` messages, the worker's summary status, and sanitized `df -h /` / `free -h` output. Do not share worker Docker environment, full logs, Redis password, hashed ACL, or application database contents. If the build fails or resources fall below the thresholds, **do not retry or prune** without reassessing the disk and memory impact.

This worker is *probe-only*. Later work to connect real editorial events and the administrative status feed is separate, gated and cannot be inferred from successful canary status.
