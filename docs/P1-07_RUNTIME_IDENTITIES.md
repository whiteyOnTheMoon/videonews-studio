# P1-07: isolated PostgreSQL runtime identities

The migration 0012 defines three dormant NOLOGIN permission groups. The dispatcher and status reconciler now require a separate, explicitly enabled PostgreSQL login identity before making a database connection. No fallback to the owner account `vns` is permitted.

The dispatcher requires `VNS_PG_RUNTIME_IDENTITIES_ENABLED=true` with `VNS_POSTGRES_RUNTIME_PASSWORD_FILE=/run/secrets/pg_outbox_dispatch_password`; the status reconciler requires the same enable flag with `/run/secrets/pg_job_status_sync_password`. The future research writer's reserved secret path is `/run/secrets/pg_research_writer_password`. All three passwords must be provided through independently mounted Docker secrets. No passwords are committed.

**Live verified (operator console, 2026-10-25):** Three distinct runtime LOGIN identities exist, each has only its matching grant-role membership, and every password authenticated via its own isolated Docker-network TCP test. The three negative cross-password and cross-service SQL checks passed. **Still blocked:** running or enabling actual dispatcher/status/research services, production research provider adapters, persistent editorial jobs and disaster-recovery acceptance. The Compose overlay remains disabled.

No VPS deployment is authorized by this code change. The existing probe-only worker remains untouched. Require disposable CI authentication and permission-denial tests using actual distinct login users before any live rollout.

## Disposable login acceptance

The worker CI harness now provisions three distinct LOGIN fixtures in an ephemeral PostgreSQL 17 container, maps each fixture to its scoped NOLOGIN grant group, authenticates over TCP with its own fixture password, verifies the authenticated SQL identity, and refuses cross-component access. These fixed fixture passwords are never production credentials. The harness does not modify the VPS database or create operational logins. Production service activation, independently mounted secrets for actual services, operational research adapters and recovery acceptance remain blocked; the individual LOGIN provisioning and isolated TCP verification were completed.

## Controlled operator rollout — not yet authorized

1. Obtain an independent, read-only VPS inventory: active container IDs, current database roles, applied migration count, Docker secret mounts, memory/disk and existing recovery evidence. In particular, do not infer migration 0012 was applied from a Git merge.
2. Prepare three different high-entropy passwords locally in separate untracked files with restrictive owner-only permissions. Never display, paste into chat, commit, pass as CLI arguments or place plaintext in logs. Verify that each container user can read **only its own** file.
3. Provision the dedicated LOGIN roles through a reviewed, narrowly scoped administrative SQL transaction. Grant exactly one corresponding NOLOGIN group to each login and no ownership, superuser, CREATE, replication or cross-service memberships. Require SCRAM authentication, verify the authentication policy and rollback strategy before writing to the VPS.
4. Authenticate separately as all three identities from their intended network and verify PostgreSQL `current_user`, allowed statements, denied cross-service DML/DDL, and negative wrong-password/cross-password attempts. Record redacted receipts only.
5. Add a separately disabled Compose overlay with individual secret mounts and explicit service flags; validate the rendered Compose configuration without starting containers. Do not replace the existing probe worker or change Web, API, Cloudflare or other projects.
6. Only after an explicit bounded operator approval, enable one component at a time with read-only receipts, error budgets, rollback and no external source, rendering or publishing side effects.

Stop if the operator login cannot be authenticated independently, if any denied query succeeds, if an unapproved service would be recreated, or if credentials would appear in a terminal transcript. The experimental no-backup exception does not establish disaster-recovery acceptance.

### CI coverage

Disposable PostgreSQL tests authenticate all three service LOGIN identities and reject cross-service writes. They also reject the use of one service's password to authenticate to another and deny schema creation. These checks do not prove VPS credential installation or safe live rollout.

## Planning-only Compose overlay

The optional `deploy/compose.editorial-ops.yaml` declares distinct dispatcher and status service containers with private backend networking, separated Docker secret mounts, resource bounds and no host ports. Both component activation flags and the shared runtime-identity activation flag are explicitly `false`. Merely selecting its `editorial-ops` profile cannot enable editorial processing. The overlay does not provision secrets or PostgreSQL login roles; missing secret files are expected until a separately approved rollout. Do not use `docker compose up` with this overlay on the VPS. The research writer is intentionally not defined as a runnable service.

## Scoped research pipeline acceptance boundary

The disposable end-to-end suite exercises the three separately authenticated logins for dispatch, research evidence persistence, and job-status reconciliation. It additionally asserts that dispatcher cannot modify job terminal status, status sync cannot modify outbox delivery, and research writer cannot modify editorial review verdicts. These negative operations are checked against the same disposable PostgreSQL instance **before** dispatching a synthetic research job. The database-owner account is used only for test fixtures and readback.

**Operator read-only inventory remains a required separate gate** before live credential provisioning. Check actual `schema_migrations` and role existence against the running VPS without assuming that Git migrations have been applied, and confirm the currently deployed Compose configuration without printing secret values. If migration 0012 is not applied, the NOLOGIN groups may not exist; no login provisioning should proceed. No production operation is authorized by these CI checks.

## Offline password-file staging (requires separate operator approval)

The reviewed helper `scripts/stage_pg_runtime_secrets.py` can generate the three **independent**, untracked password files in `secrets/` without touching PostgreSQL or Docker. It is intentionally not called by any deployed service, migration, or workflow; CI only tests it in disposable temporary directories.

When separately authorized, an operator running as UID 1000 may use `python3 scripts/stage_pg_runtime_secrets.py --stage`. It demands an owner-only `secrets/` directory, refuses symlinks and any existing/partial target, creates files with mode 0600, uses cryptographically random base64url values and prints no credentials. It will not rotate or replace an existing password. If a failure occurs during staging, only new files created by that invocation are removed. Confirm the host UID and the intended container UID before any operator action.

**The host files are not database logins.** Role creation, SCRAM `pg_hba.conf` review, login authentication, per-service Compose activation, disaster recovery and service rollout require separate gates. Applying migration 0012 alone neither provisions credentials nor authorizes editorial services.

## Proposed separate live LOGIN provisioning (not yet authorized/executed)

After the operator's read-only confirmation of migration 0012, three NOLOGIN groups, host UID 1000 and password-file ownership, the optional `scripts/provision_pg_runtime_logins.py` can prepare three **LOGIN** principals. Its explicit `--apply` mode is a persistent database write and **requires a new operator approval**. It does not run during git pull, Docker startup, migration application or CI. GitHub Actions runs only offline unit tests with mocked PostgreSQL/Docker subprocess calls.

The provisioner reads the three already-staged 0600 files through a verified owner-only directory using no-follow filesystem operations, checks distinct values, and creates salted SCRAM-SHA-256 verifiers **locally**. It streams only password-derived verifiers (never the original plaintext) through `docker exec -i ... psql` stdin, not CLI arguments, environment variables or logs. It refuses a wrong Git branch, unreviewed working-tree changes, unexpected PostgreSQL container identity, missing migration 0012, incorrect grant groups, pre-existing LOGIN users and unexpected broad `host trust` rules. A single SQL transaction creates the three non-admin INHERIT login roles, grants each exactly its corresponding NOLOGIN group, and commits atomically. It separately verifies all three logins and memberships using read-only SQL.

**Do not rerun on error after the write starts.** A connection loss or post-commit verification failure can leave the transaction committed. Inspect role state read-only first; never regenerate or print the staged passwords. This does not change `pg_hba.conf`, launch containers, enable worker flags, or prove a true Docker-network SCRAM login. The next acceptance gate is a separately authorized positive/negative password-authentication test across the backend network. No backups currently exist; this is not a recovery signoff.

Observed live preconditions from operator console (2026-10-25): migration 0012 successfully committed (12 rows), three intended NOLOGIN/NOINHERIT groups present, no LOGIN principals, empty editorial ledger, healthy existing services. Ordered HBA file shows only loopback/local `trust` and a final general `host ... scram-sha-256` rule. All three staged password files are UID 1000/mode 0600, with `secrets/` UID 1000/mode 0700. None of those observations alone authorizes running `--apply`.

## CI: bounded failure after invalid research discovery

The disposable PostgreSQL/Redis end-to-end integration also checks the negative branch using the real dormant editorial worker factory and a deliberately empty synthetic research discovery. The original success-path worker is stopped first, so there is only one consumer. The failed request must perform exactly three bounded processing attempts, generate **zero** evidence rows, remain a retained failed BullMQ job, and reconcile to PostgreSQL status `failed` with the sanitized `bullmq_failed` error code. Re-running outbox dispatch or status synchronization must not fabricate another delivery or successful state. All data and worker processes are CI-only fixtures; no VPS service or actual source is involved.
