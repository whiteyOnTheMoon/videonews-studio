# P1-07 — PostgreSQL restore evidence and deployment boundary

**Status:** CI-only recovery drill. No VPS PostgreSQL database or backup has
been provisioned, changed, or restored.

## What is implemented

The GitHub Actions workflow `p1-07-postgres-restore.yml` invokes
`db/scripts/test_backup_restore.sh`. It refuses execution unless both
`GITHUB_ACTIONS=true` and `CI=true` are set. Its temporary resources are
deleted on exit.

The drill:

1. Starts PostgreSQL 17 in a temporary source container with no network
   connectivity, no host ports and a RAM-backed data directory.
2. Applies the existing `0001_editorial_core` migration.
3. Inserts a disposable editorial fixture spanning sources, rights, claims,
   stories, scripts, jobs, videos, approvals, uploads and costs.
4. Creates a PostgreSQL custom-format logical archive using `pg_dump`, checks
   that the dump catalog is readable and records the archive checksum.
5. Initializes an independent, empty destination PostgreSQL container and
   restores with `pg_restore --single-transaction --exit-on-error`.
6. Checks restored rows, foreign-key relationships, values, migration ledger,
   constraints, and an `updated_at` trigger.
7. Refuses a second restore over the existing schema; verifies the first
   restored dataset remains intact.

The archive lives only in a GitHub runner temporary directory. It is **not**
an external backup, a persisted artifact or proof that a real VPS backup
exists.

## Recovery limits

This tests a **single PostgreSQL schema logical dump**. It does **not** back
up Redis/BullMQ state, PostgreSQL globals and roles, application secrets,
uploaded media, Docker Compose configuration, VPS volumes, or any production
credentials. It also does not exercise point-in-time recovery, host failure,
cross-version upgrades, disk-full handling, encrypted archives or automatic
rotation. Temporary-container checks are not a substitute for an operator
backup and restoration plan.

## Before enabling the data profile on the VPS

- Agree on a recovery policy, including acceptable data loss, backup frequency
  and retention. Backups stored only on the same VPS will not survive loss of
  that VPS. A paid off-site service is **not** required for this CI milestone.
- Prepare and verify an operator-owned, least-privileged PostgreSQL secret.
  Do not paste a password or connection string into chat or GitHub.
- Check free disk space and actual PostgreSQL/Redis resource consumption.
- Test the chosen **real** backup destination and a clean restore of a
  disposable copy. Do not use the production volume for restore drills.
- Implement persistent job idempotency, retries and worker crash recovery.
- Request explicit operator approval before starting the `data` and `worker`
  profiles or creating permanent database volumes.

The production P1-06 web/API/tunnel remains on its separately approved image
digests. No workflows here publish images or operate on the VPS.
