# P1-07 — Post-probe live receipt and SQL isolation audit

**Current evidence (operator-provided, 2026-10-25):** PostgreSQL 17 and Redis 7 are healthy on the VPS with no host-published ports. All 11 SQL migrations are applied. The restricted BullMQ worker is running with concurrency 1 and the operator has successfully run the one-time harmless live probe, which reported completion and retention in Redis. Operator accepted a no-backup experimental deployment. This is not proof of editorial processing or of independent disaster recovery.

## Purpose

The read-only helper `scripts/p1_07_live_probe_receipt.sh` verifies the retained *existing* fixed-ID probe result. It never calls `Queue.add`, never removes or retries a Redis job, and never starts, restarts or stops any container. It checks the original worker's Docker Compose identity and image provenance, private Redis network, healthy data services, Redis ACL identity, and that the retained job is a completed `probe` with only `{kind: "probe"}`, exactly one attempt, `{ok: true}` return value, and persistent completion/failure records.

On the live VPS it also runs **only SELECT statements** against PostgreSQL, requiring exactly 11 migration records, no editorial jobs, no outbox intents, and no operator registry entries. This establishes that the probe did not require touching editorial SQL, provided no other workload has subsequently added entries. A nonzero count is a **stop condition** to investigate; do not delete tables or queue records to make the test pass.

The worker image was built from an older, verified Git commit. The receipt script checks that the **running image ID** matches the labelled `vns-worker:local` image and that the recorded build commit remains an ancestor of the updated checkout. A clean `git pull --ff-only` does not by itself require rebuilding or restarting the worker.

## Operator procedure

The helper is tested in disposable GitHub CI against a retained probe and repeat read-only audits before being merged. After applicable CI passes and the reviewed PR is merged, use:

```bash
cd /home/ap/www/videonews-studio || exit 1
git status --short
git pull --ff-only origin main
bash scripts/p1_07_worker_canary.sh status
bash scripts/p1_07_live_probe_receipt.sh
df -h /
free -h
```

Only `PASS` or generic `REFUSED` lines and summary resources should be shared; never share Redis secrets, ACL hashes, Docker environment variables or raw sensitive logs. Unlike the earlier one-time **enqueue** script, the **receipt** script can be rerun if needed because it is read-only, but do not rerun `scripts/p1_07_live_probe.sh`.

A passing receipt verifies **probe-only** authenticated Redis processing, not PostgreSQL-to-Redis outbox dispatch, status-sync, source research or video rendering. Neither dispatcher nor status sync is started by this verification. The 12 full recovery gates remain closed because no independent backups or restore test exist.
