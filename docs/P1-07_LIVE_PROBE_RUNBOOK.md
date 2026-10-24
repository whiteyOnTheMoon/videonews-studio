# P1-07 — First one-time live BullMQ probe (no editorial jobs)

The operator has successfully launched the restricted `videonews-studio-worker-1` worker, and confirmed PostgreSQL/Redis remain healthy, Redis ACL authenticated access works and no worker ports are published. The worker can **only** process the harmless `probe` kind with concurrency 1; it does not research, render, upload, distribute or consume PostgreSQL outbox intents.

## What this step proves

`scripts/p1_07_live_probe.sh` validates the actual running worker and Redis container labels, healthy Redis, their exclusive private Docker network and absence of host-published ports. It verifies the running image matches the locally labelled `vns-worker:local` image and that the image's reviewed build SHA is a known ancestor of the updated Git checkout. On a live VPS it also verifies PostgreSQL, current Web/API/tunnel health, previously confirmed named Redis authentication and minimum disk/RAM reserve.

Only after these checks, the script sends a **single** `probe` job with the fixed ID `p107-live-one-time-probe` to the restricted `bull:vns` namespace using the local read-only mounted worker password. The password is read **inside** the running worker container, not echoed to the shell, placed in command arguments or committed. The submitted payload contains **only** `{kind:"probe"}`. It has one execution attempt, awaits a `completed` result with `{ok:true}`, and intentionally leaves the completed Redis job as evidence.

**Single-use:** if the job already exists or a timeout/error occurs, the script stops and must **not** be rerun or the Redis record deleted. On a failure, inspect the result and current health without flushing the queue. All original editorial tables remain untouched. Do not start dispatchers, migrations, worker restarts or real editorial jobs to diagnose a probe.

## Existing Git checkout vs. deployed image

The worker image was built from the main-branch revision current at deployment. Subsequent documentation/test changes and a clean `git pull --ff-only` do not replace that running image. `scripts/p1_07_worker_canary.sh status` now verifies the actual image ID and its recorded revision instead of incorrectly requiring the running image to have been rebuilt on the new Git head. New **build/start** operations still retain their stricter revision and no-existing-container rules.

## Operator procedure after successful GitHub CI and merge

```bash
cd /home/ap/www/videonews-studio || exit 1
git status --short
git pull --ff-only origin main
bash scripts/p1_07_worker_canary.sh status
bash scripts/p1_07_live_probe.sh
df -h /
free -h
```

Return only the sanitized `PASS`/`REFUSED` lines, summary and resource figures. **Do not** paste Redis credentials, worker environment, full logs or private database records.

No backup exists by the operator's deliberate 0-budget choice, so a complete VPS/disk loss can erase PostgreSQL/Redis data and even the probe evidence. A healthy worker and harmless live probe do not satisfy the twelve standard recovery release gates and are not proof of the editorial research/video pipeline. The next separately designed steps are restricted PostgreSQL-to-Redis outbox dispatch and status reconciliation; neither is started by this one-time probe.
