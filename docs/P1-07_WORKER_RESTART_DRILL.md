# P1-07 — Controlled probe-worker-only restart drill

**Scope:** Authorized experimental no-backup operation, **not** full disaster-recovery acceptance. Operator already confirmed on the live VPS a healthy PostgreSQL 17 / ACL-protected Redis 7 pair, all eleven migrations, a probe worker with concurrency one, a completed single-use probe, and a read-only stored receipt. The last operator-supplied queue inspection had **zero waiting/active/delayed/failed jobs and exactly one completed probe**.

## Safeguards

- `scripts/p1_07_worker_restart.sh preflight` is **read-only**. It invokes the existing worker health check and saved-probe/SQL isolation audit; reads every relevant BullMQ queue state via `scripts/p1_07_idle_queue_check.mjs`; and refuses unknown jobs, any failed/unprocessed work or incomplete inventory. On the live VPS it requires at least 1800 MiB available RAM and 15 GiB free disk.
- `restart` repeats the entire preflight **immediately before** touching the existing worker, then runs **only** `docker restart --time 20 videonews-studio-worker-1`. It does not build/pull images, change Docker Compose configuration, start outbox dispatch or status reconciliation, submit new queue jobs, restart PostgreSQL/Redis/Web/API/Cloudflare, remove evidence or delete volumes.
- It checks the new worker start time, running state and new `probe worker ready (concurrency: 1)` message; captures container IDs and start times for every other VideoNews service and requires them to remain unchanged. It then repeats the authenticated status, saved receipt and read-only complete queue audit.
- The live probe's fixed ID is `p107-live-one-time-probe`. Exactly that one completed receipt must remain. A separate trusted disposable GitHub Actions fixture may use exactly its two controlled CI-only probe IDs; an override cannot be used under normal VPS execution.
- A failed preflight is a hard stop. If the restart itself fails, do **not** rerun it blindly, restart data services, delete Redis data or invoke `docker compose down -v`. Inspect worker state and retained evidence without modifying it.

The smoke test validates only the **idle worker restarting while Redis stays up**. It does not simulate Redis loss, PostgreSQL failure, recovery from a stalled editorial job, exactly-once delivery, external side effects or offsite backups. All twelve recovery gates remain false under the operator's experimental no-backup exception.

## On the operator's VPS

After PR's isolated latest-head CI has passed and it has been merged, from the existing clean `main` checkout:

```bash
cd /home/ap/www/videonews-studio || exit 1
git status --short
git pull --ff-only origin main
bash scripts/p1_07_worker_restart.sh preflight
bash scripts/p1_07_worker_restart.sh restart
bash scripts/p1_07_worker_canary.sh status
df -h /
free -h
```

The `restart` action has a fresh preflight of its own. Share only status/PASS/REFUSED and resource output. Do not include raw logs, environment variables, passwords or Redis ACL secrets. This is a **targeted Worker restart**, not permission to enable research/render/upload or publication. The real editorial dispatcher must remain disabled while the worker is probe-only.
