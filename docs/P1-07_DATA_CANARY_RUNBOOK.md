# P1-07 — Approved, operator-run database canary (NO BACKUPS)

**Release class:** experimental, data-loss-accepted trial — **not** the backup-compliant/recoverable production release. On 2026-10-25 the operator expressly authorized the P1-07 implementation and container starts **only if checks pass**, with zero backup budget. PostgreSQL/Redis are the first narrow stage. There is no authenticated operator SSH connector in this chat, so the operator must execute the script on the VPS and return its sanitized output. The assistant has not run any VPS command.

## Scope and safety limits

- Start at most two **new** VideoNews-specific containers: `videonews-studio-postgres-1` and `videonews-studio-redis-1`, using `compose.yaml`, the existing Compose project name and **explicitly named services only**.
- Do **not** start a worker, outbox dispatcher, status synchronizer, editor-account onboarding or public admin data feature flag in this stage. The current worker is probe-only and would reject actual editorial jobs.
- Do **not** replace, recreate or restart the already healthy web, API or Cloudflare tunnel containers or any Kurvenfunk, WordPress or other services.
- Never publish host ports for databases or attach the project backend to an external network.
- Redis ACL and Postgres passwords are generated on the VPS and excluded by Git from repository commits. Never send values, `docker inspect` environment, files, SQL dumps or secrets to chat.
- There are **no backups**. Disk loss, destroyed volumes, corruption, mistaken edits or VPS loss can permanently erase database/queue state. A `stop` command preserves volumes but **cannot restore lost data**. All twelve full-recovery gates remain **false**.

## Observed operator-provided snapshot

7.8 GiB RAM / 3.2 GiB available; swap 828 MiB in use; root disk 116 GB total / 23 GB free / 81% full, with 19% inode usage. Existing VideoNews web/API healthy and tunnel running, Git checkout `7070098` clean at the time. Forty running containers were reported. These are **time-specific snapshots**, not a capacity guarantee.

The canary script `scripts/p1_07_data_canary.sh` aborts if root has less than 15 GiB free, disk reaches 85% usage, or freeable RAM reported by `free` is below 1800 MiB. It also checks the existing app/tunnel health and refuses to replace pre-existing VideoNews database container names. No Docker prune, cache cleanup or delete-volume action is in the script.

## Operator procedure — each command is a separate stage

Run from a trusted terminal on the previously inspected VPS. **Review any upstream commit changes before fetching the new main branch if the host has been independently modified.** Never force/reset a dirty checkout.

```bash
cd /home/ap/www/videonews-studio || exit 1
git status --short
git branch --show-current
git pull --ff-only origin main
bash scripts/p1_07_data_canary.sh preflight
```

If preflight PASS reports safe headroom and no existing data containers, generate local secrets. This action is **not reversible without planned credential rotation**; if it rejects existing files, stop and review rather than deleting them.

```bash
bash scripts/p1_07_data_canary.sh provision
```

Only after the above succeeds, start the two containers by their exact service names:

```bash
bash scripts/p1_07_data_canary.sh start
bash scripts/p1_07_data_canary.sh status
```

The script uses `docker compose --project-name videonews-studio -f compose.yaml --profile data up -d --no-deps --no-build --pull missing postgres redis`. It may download the two official database images if missing and create **new persistent data volumes**. The worker profile is not enabled. If image pulls exceed available capacity, the script can refuse/exit; do **not** compensate by deleting unknown images or volumes.

**If anything fails:** capture only non-secret health/state and resource metrics; do not paste raw application logs because they can include private data. To stop _only_ the data services without deleting their data:

```bash
bash scripts/p1_07_data_canary.sh stop
```

Do not execute `docker compose down -v`, `docker volume rm`, `docker system prune`, unreviewed migrations, a worker start, `--profile ingress`, or any global Compose `up`/recreate command. The existing Web/API/Tunnel must remain healthy throughout.

## After health confirmation

Send back redacted `start` and `status` output only. We can then verify isolation, disk/RAM trend and database authentication, design PostgreSQL schema migrations and least-privilege role setup, and determine if any separately gated worker probe can safely operate without editorial jobs. **No secret values, no real editorial jobs and no claims of successful off-host restoration.**

The [full recovery runbook](P1-07_RECOVERY_RUNBOOK.md) and [no-backup decision](P1-07_OPERATOR_NO_BACKUP_DECISION.md) continue to document the difference between experimental availability and recoverable production.
