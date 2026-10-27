# P1-07 — Full-stack recovery runbook and release gates

**Status: full disaster recovery is NOT approved.** On 2026-10-27 the operator
reported regular IONOS backups and functioning Beszel monitoring. The IONOS
backup product, protected data volumes, retention, independent recovery access,
recovery objectives and full-stack restore drill are **not yet verified**.
See [P2-02 IONOS/Beszel acceptance](P2-02_IONOS_BESZEL_ACCEPTANCE_2026-10-27.md). The **2026-10-25 operator-approved
no-backup experimental exception** allowed a narrowly isolated PostgreSQL 17,
Redis 7 and probe-only worker rollout on the VPS. Their health, eleven schema
migrations, ACL, a retained harmless BullMQ probe and an idle worker-only restart
have since been confirmed by the operator. The original blanket ban on data
and worker startup in this runbook is therefore historical for that **specific
experiment**, not a general ban still in force. It does **not** authorize real
editorial processing, publication, untested service additions or claims of
recoverability. See [live acceptance status](P1-07_LIVE_ACCEPTANCE_STATUS.md).
All twelve full-recovery gates remain **false**.

This runbook and the associated
[`p1-07-recovery-plan.json`](p1-07-recovery-plan.json) are planning
artifacts, **not an executable disaster-recovery command list**. No
credentials, hostnames, real storage buckets, personal operator names or
deployment approvals are stored here.

## Decisions required before any data/worker profile activation

The independent operator must explicitly decide and document:

| Decision                                                | Current approval          | Evidence to collect                                                             |
| ------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| Off-host storage location, ownership and access         | **IONOS backups reported; scope unverified** | Independent destination, access controls and recovery-access proof              |
| Recovery point objective (RPO, acceptable data loss)    | **Not defined**           | Explicit maximum tolerable lost data, agreed retention and backup schedule      |
| Recovery time objective (RTO, time to resume)           | **Not defined**           | Explicit recovery target and completed realistic, timed rehearsal               |
| Backup encryption and independent key custody           | **Not approved**          | Audited key recovery and authorized access to an offline recovery copy          |
| Retention, privacy, deletion and audit completeness     | **Not approved**          | Approved policy for people, review reasons and other sensitive metadata         |
| Media and external assets                               | **Not backed up**         | Hash-verified upload/media inventory and independent restored copy              |
| PostgreSQL data, globals, roles and login secrets       | **CI-only tested**        | Full off-host database restore, reissued individual credentials                 |
| Redis AOF/BullMQ and PostgreSQL outbox consistency      | **Not full-stack tested** | Reconciliation and duplicate/retry handling before workers resume               |
| Signed audit data                                       | **CI-only tested**        | Independent public-key trust, signature/key rotation, immutable off-host anchor |
| Config, tunnel, third-party credentials and publication | **Not rehearsed**         | Independently retained configuration and post-restore nonpublication check      |
| Real identity/MFA and administrator grant approvals     | **Not complete**          | Operator-owned authorization and revocation evidence                            |
| Explicit live activation                                | **Not granted**           | New human approval for VPS migration, containers, flags and cutover             |

Cost constraint: **do not provision or subscribe to a new backup service
automatically**. A future approved backup plan might use an operator-owned
independent destination. GitHub source code is not a substitute for backing
up application data, keys or media. A backup kept only on the same VPS is
not resilient to complete VPS loss.

## Scope and what the CI evidence really proves

- The existing `test_backup_restore.sh` exercises an isolated
  PostgreSQL 17 **schema-only** recovery for migrations 0001–0005.
- The newer `test_full_restore.sh` exercises **all 11** migrations with
  test data, global PostgreSQL roles and memberships, GRANT/ACL checks,
  immutable audit tables, triggers, saved editorial data and outbox rows.
  It detects truncated dumps, missing global roles and unsafe double restore.
  It still excludes live login passwords and other databases. PostgreSQL 17
  role grantor provenance differs on a fresh differently bootstrapped target;
  review this deliberately before any real cutover.
- The `ci_audit_export.mjs` and `ci_signed_audit_replay.mjs` work only on
  disposable CI data, with a short-lived Ed25519 test key. Neither creates
  a trusted off-host archive or proves completeness, freshness, database
  disaster recovery or real key custody.
- No existing test captures Redis persistence, secret escrow, uploaded
  media, working Cloudflare configuration, domain/DNS ownership, Docker
  volumes, publishing platform authorizations or the combined restore order.
  No test measures a meaningful full-VPS RTO or RPO.

## Recovery order — operator-controlled, on an isolated target first

The machine-readable plan has fourteen intentionally ordered milestones,
with dependencies checked on every PR by GitHub Actions. It remains
`offline-design-only`: every release gate is false, every supporting
evidence reference is null, the `data`, `worker` and `ingress` profiles
are false, and RPO/RTO are null.

1. **Freeze.** Stop accepting _new_ editorial jobs and publication requests,
   halt dispatchers/workers in the approved incident plan, preserve evidence.
   Do not overwrite a failed database or destroy an original volume.
2. **Verify provenance.** Independently locate and authenticate a recent
   approved off-host backup set, its digest/signature and encryption keys;
   check backup age against the operator's RPO. If incomplete, **stop**.
3. **Isolate.** Prepare a clean disposable recovery host/network without
   public ingress or a published PostgreSQL/Redis host port.
4. **Recover configuration and secrets.** Obtain trusted, non-GitHub
   application/tunnel settings and recovery key material through approved
   independent custody. Rotate/reissue compromised keys rather than
   reusing incident-tainted credentials.
5. **PostgreSQL globals first.** Restore carefully reviewed roles and
   memberships under the authorized recovery administrator. Validate
   membership options and changes to GRANT grantor provenance.
6. **PostgreSQL data second.** Restore databases and migrations to the
   empty target; validate foreign keys, audit controls, roles, event
   history and complete row fingerprints. Do not use `--clean` against
   any live database.
7. **Restore uploaded media** from its independent backup; compare content
   hashes and inventory against the database, including license/rights
   provenance. Missing assets **block any publication**.
8. **Verify independent audit archive** with a separately trusted public
   key, signed anchor and freshness/completeness evidence. Audit gaps
   require incident escalation; do not fabricate continuity.
9. **Redis decision.** Recover Redis AOF only after validating that
   persistence and queue semantics are safe; alternatively treat Redis as
   lost and prepare controlled reconstruction **with workers still stopped**.
   Redis is not the source of truth for persisted research/job intent.
10. **Reconcile PostgreSQL outbox and BullMQ.** Match idempotency IDs,
    pending/enqueued claims, retries, stalled jobs and duplicate delivery.
    Never claim exactly-once execution. Do not launch dispatchers/workers
    before explicit reconciliation signoff.
11. **Reissue database logins.** Restore least-privilege service and
    separately attributable human operator credentials, rotate exposed
    secrets and verify authorization, deactivation and audit attribution.
12. **Validate internal services offline.** Keep new feature flags disabled,
    public ingress closed, and publication/upload integrations inert while
    checking health and data-access behavior.
13. **Validate application integrity.** Confirm no accidental outside
    publication, audit continuity, media/reference consistency, queue
    idempotency and no pending unreviewed unsafe side effects.
14. **Explicit operator release gate.** Independently approve cutover
    and any new `data`, `worker`, `ingress` or source-review flags only
    after all evidence is available. Approval cannot be inferred from CI.

The dependency DAG is deliberately strict. Redis may be lost while
PostgreSQL outbox intent survives; this does **not** justify blindly
re-enqueueing or marking jobs completed. Manual intervention is required
for failed reconciliation and for any evidence of already-published work.

## Failure decisions and rollback

| Failure                                             | Safe response                                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Backup missing, expired, unsigned or inaccessible   | Stop restoration; preserve incident evidence; no activation                               |
| Decryption/signature trust cannot be established    | Treat archive as untrusted; do not invent a new trusted key                               |
| Global database roles missing, owner/ACL mismatch   | Abort; correct on a fresh test target; never weaken runtime DB permissions                |
| Backup incomplete or restored audit trail diverges  | Quarantine target, investigate; no synthetic replacement audit events                     |
| PostgreSQL and Redis job state disagree             | Freeze workers; investigate outbox duplicates and at-least-once replay manually           |
| Media missing, damaged or license rights unknown    | Block upload/publication for affected items                                               |
| Compromised operator or application credentials     | Revoke/rotate through independent trusted procedures; review audit trail                  |
| New deployment unhealthy                            | Keep public traffic and worker execution disabled; revert only per operator-approved plan |
| RPO/RTO not approved or restoration time unmeasured | Do not claim readiness or activate the data profile                                       |

## Automated regression checks

The `p1-07-postgres-restore.yml` workflow runs:

- the original disposable baseline PostgreSQL restore,
- the complete PostgreSQL globals/schema/ACL restore, and
- `node --test scripts/test_recovery_readiness.mjs`, a **pure**
  no-network, no-Docker test of the machine-readable release gates and
  14-step dependency order, including adversarial mutations such as
  skipping queue reconciliation, enabling workers or inventing a backup
  destination.

This third job validates the **plan**, not a real external backup,
MFA, keys, Redis/media recovery or live RTO/RPO. No files are uploaded as
artifacts. Every future implementation must add its own independent CI
evidence; changing a bool in JSON does not constitute operator approval.

**Production boundary:** no action in these tests or documents logs in to
the VPS, creates new VPS containers, changes Compose configuration,
enables a flag or approves a production migration. Those operations
remain out of scope until the operator explicitly authorizes them.

## Read-only PostgreSQL/BullMQ pre-restart mismatch drill (GitHub Actions only)

The disposable worker workflow now invokes
`scripts/test_ci_outbox_recovery_audit.mjs` against the existing isolated
PostgreSQL 17 and authenticated Redis 7 test containers, without starting
a publication, rendering or research worker. A newly created, individually
authenticated synthetic PostgreSQL LOGIN is granted only `USAGE` on the
application schema and `SELECT` on `vns.jobs` and `vns.job_outbox`.
It does not inherit the dispatcher role, whose UPDATE privileges would be
unsafe for an independent recovery observer. The test explicitly rejects
table writes, reading editor accounts and switching to a privileged role.

The inspect-only module `scripts/ci_outbox_recovery_audit.mjs` performs a
bounded PostgreSQL `REPEATABLE READ READ ONLY` transaction and examines
deterministic BullMQ job IDs for persisted PostgreSQL jobs. It reports
pending jobs absent from Redis, Redis enqueue ahead of database
acknowledgment, missing Redis jobs after acknowledgment, conflicting queue
payloads, and terminal database jobs with runnable queue records. A
simulated Redis disconnect fails closed. SQL and Redis snapshots are not
atomic together, so an observation may change while being collected.

The implementation **never** re-enqueues, retries, acknowledges, marks a
job complete, starts workers, or mutates a database or Redis record.
Synthetic CI fixtures test the observations and verify that repeated
inspections leave the job/outbox rows and queue counts unchanged. The
report always requires operator approval even when it sees no conflicts.

This is not production-ready reconciliation or Redis AOF disaster
recovery. It scans **only the bounded, enumerated BullMQ states and visible jobs**;
deleted/expired Redis job keys, jobs from unknown Redis namespaces, and
external side effects remain unobserved. It is capped to a small CI
dataset; exceeding that cap is an error,
not permission to ignore old jobs. Before any worker restart, the
operator must independently inventory the entire BullMQ queue,
verify retained Redis AOF or a safe reconstruction plan, address
completed/failed jobs and duplicate external side effects, and
explicitly approve a new recovery run. The full-stack backup,
media, signing, key custody and activation gates remain CLOSED.

## Redis-only orphan inventory and isolated Redis AOF restore rehearsal

The read-only recovery inspection now inventories BOTH sides in the
disposable worker CI: it compares all PostgreSQL outbox job IDs against
BullMQ's `waiting`, `paused`, `delayed`, `active`,
`waiting-children`, `completed` and `failed` job states.
A Redis job without matching PostgreSQL intent is flagged as an
**orphan Redis job**, including unexpected/nondeterministic queue IDs.
The observer checks BullMQ counts against the retrieved inventory and
**fails closed** if more than 50 jobs exist, if a read is incomplete,
if an ID occurs twice or if PostgreSQL/Redis becomes unavailable.
Neither the observer nor its negative tests ever authorize, resume,
enqueue, delete or mark jobs completed.

The independent `redis-aof-recovery` GitHub Actions job uses two
ephemeral authenticated Redis 7 containers and a temporary test-only
bind mount on the **GitHub runner**, not on the VPS. The first process
stores synthetic waiting and delayed BullMQ jobs using multipart AOF
with `appendfsync always`, then stops cleanly. After hashing the
complete stopped AOF archive (including the Redis multipart manifest),
the test copies it to a clean directory, detects a deliberately
modified AOF segment via SHA-256, and performs a **two-stage isolated recovery** against the verified
copy. Redis 7's AOF replay runs commands under the default ACL; with the
normal `user default off` it may log CRITICAL `NOPERM` errors on
`MULTI/EXEC`, start successfully, and silently omit queue jobs. The
test therefore bootstraps the verified AOF with a **CI-only temporary
recovery ACL** inside a container with `--network none` (no exposed
port, workers, or integrations), verifies the loaded keys, rewrites the
AOF into a fresh RDB-base segment, stops that process, then starts
a **new, authenticated Redis process under the original restrictive
ACL** and checks the same job IDs, payloads, retry options and queue
states. The recovery ACL is NEVER mounted into an externally reachable
CI container or deployed anywhere.

These are **CI recovery rehearsals only**, not production Redis backups.
A SHA-256 checksum from the same machine is not independently trusted
or digitally signed. A clean shutdown plus `appendfsync always` does
not exercise a power-loss window or prove a real RPO, and the test
does not intentionally boot a corrupted Redis AOF. The probe does not
prove an atomic PostgreSQL+Redis point-in-time snapshot, observe jobs
already removed/expired, inventory arbitrary unknown Redis prefixes,
deduplicate external side effects or recover private credentials.
Production off-host retention, signing, encryption, independent
backup/restore, orphan-resolution policy, media, key custody, safe
worker restart and operator approval remain explicitly **unapproved**.

## Redis AOF archive preflight and replay-error stop conditions

A separate GitHub Actions-only `ci_aof_archive_preflight.mjs`
now inspects the **stopped** disposable Redis 7 multipart AOF before
the temporary network-isolated bootstrap starts. It requires exactly
one `appendonlydir`, a bounded valid Redis AOF manifest with one
base segment and at least one incremental segment, matching sequence
numbers and types, and no missing, extra, duplicate, hard-linked,
symlinked, traversing, oversized or unrecognized archive files.
It creates a local SHA-256 and file-length inventory **outside** the
archive after source shutdown. A copy must match that inventory in
full; changed files or manifest layout prevent Redis startup. The
integration also runs explicit adversarial archive mutations and
rejects them. The CI verifier checks Redis bootstrap and strict-ACL
target startup logs for `CRITICAL` or `NOPERM` rather than treating
a live Redis process as evidence of successful job recovery.

These checks reduce the chance of silently accepting corrupt,
partial or unsafe **synthetic** AOF directories. They do not provide
authenticated provenance, an off-host trusted manifest, an independent
signing key, a complete Redis/PG atomic snapshot, a recoverable
production secret or approval to start workers. The file inventory
is generated and retained only on the same disposable GitHub runner;
an attacker controlling both inventory and archive can replace both.
The network-isolated bootstrap uses a temporary CI-only ACL solely to
replay a verified archive. Its existence is not permission to
introduce that ACL to an externally reachable server or production
system. Production disaster recovery remains blocked pending an
independent threat review, security-approved recovery credentials and
keys, off-host backup and retention policies, and a human cutover
approval.

## Encrypted synthetic backup and independently pinned key rehearsal

See [P1-07 backup key custody design](P1-07_BACKUP_KEY_CUSTODY.md).
A new GitHub Actions-only recovery job verifies a small synthetic
AES-256-GCM encrypted archive signed by Ed25519. Successful restoration
requires a **separately supplied** decryption key, approved public
signing-key fingerprint and exact expected backup generation. The CI
checks key rotation and revocation, modified files, wrong keys and
old-generation rollback. It persists neither signing nor encryption keys,
does not upload archives and does not choose an off-host destination.
It does not constitute a production backup or a real independently
anchored signature. The 12 release gates, including off-host storage,
encryption-key custody and human deployment approval, remain **false**.

## Repository recovery component inventory (planning-only)

See the [machine-readable 22-component inventory](p1-07-recovery-inventory.json)
and its [recovery inventory explanation](P1-07_RECOVERY_INVENTORY.md).
The inventory identifies source-rebuildable files, PostgreSQL/Redis
state and audit records needing off-host copies, replaceable service
credentials, nonreplaceable historical decryption-key custody, and
externally controlled tunnel/DNS/publication assets. It records no
real VPS configuration, personal secrets, storage destination or
approval. Every entry is unverified. New GitHub CI checks that
repository evidence anchors still exist, all recovery dependencies
are declared, the inventory covers exactly 22 explicitly reviewed
components, and every previously missing restore/backup approval
remains missing. This improves _completeness of planning_, not the
recoverability of the actual server. No storage or other paid
service has been selected.
