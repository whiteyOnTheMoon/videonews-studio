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

## Expanded recovery drill: full P1-07 schema and global PostgreSQL roles

The earlier `test_backup_restore.sh` drill remains a valuable, independent
baseline for migrations 0001–0005. A **separate** job in the same
`p1-07-postgres-restore.yml` GitHub Actions workflow now runs
`db/scripts/test_full_restore.sh` on a fresh PostgreSQL 17 source/destination
pair, using isolated `--network none` containers with RAM-backed data
directories, no host volume and no exposed ports.

The expanded drill performs these checks:

1. Applies **all eleven migrations 0001–0011** in the disposable source.
   Seeds relational editorial data, queue/outbox recovery state, a legacy and a
   named source-review decision, editor-account creation/password rotation/
   activation/deactivation, and synthetic operator enrollment and lifecycle
   events. These test identities, password hashes and login roles never
   touch the production environment.
2. Exports both a full `vns` schema **including ownership and GRANT/REVOKE
   ACLs** (`pg_dump --format=custom --schema=vns`) and separate PostgreSQL
   **global roles and role memberships** (`pg_dumpall --globals-only
--no-role-passwords`). Global-role passwords are intentionally excluded.
3. Validates archive magic, archive catalog and SHA-256 checksums and tests
   that a corrupted archive or truncated catalog is rejected before restore.
4. Starts an independent clean target with a differently named bootstrap
   superuser. First attempts the restore **without** global roles and checks
   the transaction fails, leaving no partial application schema.
5. Restores global roles first, then restores all `vns` objects and data
   using `pg_restore --single-transaction --exit-on-error`, **without**
   suppressing owners or privileges. PostgreSQL 17 records role-membership
   grantors in the globals dump: where the original `postgres` grantor cannot
   re-grant on a fresh independently bootstrapped cluster, the CI restore
   explicitly reissues the **same memberships and option flags** as its
   new bootstrap superuser. Only role-grantor provenance changes. Unknown
   grantor formats fail closed; the original dump is retained and hashed for
   the duration of the test. A production cutover must separately review
   grantor provenance and privileged-role membership policy.
6. Verifies all migration ledger entries, all nine non-login application
   roles, the synthetic role membership, scoped SQL function owners and
   execute permissions, denied API/dispatcher/provisioner privileges, audit
   triggers and append-only constraints, lifecycle session revocation
   versions, governance attribution, named and legacy source-review events,
   and linked editorial/outbox data.
7. Compares a deterministic fingerprint of **every ordinary vns table**
   in source and target, not just selected fixture counts. A second attempted
   restore over existing state must fail without altering the recovered
   fingerprint.

The CI archive, synthetic globals, fingerprints and test databases are
deleted on job exit; no artifacts are uploaded and no private runtime
secrets are used. The restore provides **evidence that the current GitHub
schema can be reconstructed together with its PostgreSQL ACL/role boundary**
in a clean disposable PostgreSQL 17 instance. It does not prove that
production credentials, connection configuration, external storage or
operators can be recovered.

### Unresolved operational recovery gates

There is **still no approved production backup or restore plan**.
`--no-role-passwords` means restored login credentials must be safely
reissued under an approved, independent secret-management process.
`pg_dump --schema=vns` deliberately excludes other databases, extensions
outside that schema, database-level settings, Redis/BullMQ runtime state,
uploads/media, container volumes, Compose files, Cloudflare configuration,
secrets and third-party credentials. This is logical recovery, **not**
physical/PITR recovery, off-host retention, encryption, disaster recovery,
or evidence of real recovery-time and recovery-point objectives.

Audit-ledger integrity checks in CI do not replace independently anchored
cryptographic signatures, durable off-host storage or privileged DBA
monitoring. Before any VPS activation, the operator must explicitly approve
the backup destination, access controls, retention, encryption and key
custody, off-host restore rehearsal, actual role/login secret rotation,
external dependencies recovery order and measurable recovery objectives.
Do **not** run this disposable test script against production.

## Recovery readiness remains explicitly blocked

The [P1-07 full-stack recovery runbook](P1-07_RECOVERY_RUNBOOK.md) now
documents the manual recovery order for PostgreSQL, Redis/BullMQ, uploaded
media, audit archives, configuration/secrets, internal services and
operator-controlled ingress. Its versioned
[`p1-07-recovery-plan.json`](p1-07-recovery-plan.json) records **14**
ordered milestones and **12** release gates, all closed by default.
The `full-stack-readiness-contract` CI job tests missing steps and
dependency ordering and rejects premature profile activation, invented
RPO/RTO numbers, unsupported destinations and fabricated approval
evidence.

**Important:** a green plan-validation job is **not** proof of real
full-stack restoration. The two existing PostgreSQL restore jobs remain
separately required. There are still no approved off-host backups, budget,
retention rules, trusted independent archive, restored live media, Redis
queue reconstruction, measured recovery objectives or VPS cutover
permission. This change neither selects/purchases storage nor deploys
anything.

## 2026-10-25 — Git-only synthetic token receipt extension (P1-09)

The original sections above are historical acceptance descriptions for
migrations up to 0011. The evolving disposable full-schema restore script
now includes **0012** and the proposed **0013_synthetic_token_usage**.
The restored source/destination fixture includes an immutable **synthetic**
per-job token/cost receipt; the all-table fingerprint and SQL assertions
include its values and deny application-role access. This does **not**
confirm 0013 is deployed, a real provider event was ingested or any VPS
PostgreSQL backup exists. The synthetic-only extension is detailed in
[P1-09 token usage ledger](P1-09_TOKEN_USAGE_LEDGER.md).
