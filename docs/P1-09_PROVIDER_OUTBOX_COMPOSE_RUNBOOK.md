# P1-09 — Dormant provider outbox Compose deployment contract

**Scope:** deployment configuration for the tested real PostgreSQL-to-Redis
one-shot producer in #333. No schema application, passwords, Redis ACL update,
image publishing, container startup, provider transport, or paid calls are
performed by this package.

## Exact execution boundary

When resolving this overlay, both the `data` and `provider-outbox` profiles
must be selected because the PostgreSQL and Redis dependencies belong to
`data`. Configuration inspection never starts those dependencies; any later
operator-approved run must use `--no-deps` and must not recreate them.

The opt-in `provider-outbox-once` service is defined only by
`deploy/compose.provider-outbox.yaml` and requires an explicitly reviewed,
digest-pinned worker image (`VNS_PROVIDER_OUTBOX_WORKER_IMAGE`).
The service is **not** part of the regular Compose deployment.
It has no image build, host port, scheduler, health loop or restart policy.
The entrypoint is exactly `provider-outbox-once.js --once`, capped at five
items per run by the existing worker implementation. No AI/usage worker is
started. The embedded provider live/canary flags are hard-disabled.

Required operator-supplied settings before a _separately authorized_ run:

| Variable                               | Intended value                                             |
| -------------------------------------- | ---------------------------------------------------------- |
| `VNS_PROVIDER_OUTBOX_WORKER_IMAGE`     | Reviewed GHCR worker manifest `@sha256:<64 hex>`           |
| `VNS_PROVIDER_OUTBOX_PRODUCER_ENABLED` | `false` until an individually approved one-shot invocation |
| `VNS_PROVIDER_OUTBOX_OPERATOR_ACK`     | `false` until the same approval                            |

The Compose file fixes identity, DB, queue and paths, including a
non-overridable source directory `./secrets/vns-outbox`. The producer must
**never** mount `./secrets/vns`, which can contain the unrelated
`provider-master-key` used to seal vendor API credentials. The private host
directory must be UID 1000, mode 0700, non-symlink, with three distinct
private files. The implementation requires both password files to be
owner-readable regular files of mode 0400 or 0600, with unique 40–256-character
ASCII credentials (trailing newline permitted), and a 32-byte **binary**
`provider-prompt-key`. All mounted paths are read-only, and Compose refuses
creating an absent host directory. Do not paste credentials or cryptographic
key material into Git, chat, logs, or issue comments.

The custody helper stages these files **only** under
`./secrets/vns-outbox`, never in the API's `./secrets/vns` directory.
The host directory must be created privately by the operator before staging
and must not be a symlink. The separate API prompt-sealing path currently
expects `./secrets/vns/provider-prompt-key`. A later independently approved
key-distribution procedure must place the **same 32 bytes** in that API path
without revealing the key, overwriting an existing file, introducing a
symlink/hardlink, or exposing the provider master key to the producer.
Neither this PR nor the staging helper performs that API key distribution;
do not enable admin job submission until the match is verified.

Files expected in the mounted directory:

- `provider-outbox-db-password`: dedicated SCRAM login `vns_provider_outbox_login`, inheriting only the `vns_provider_outbox_reader` NOLOGIN role from migration 0048.
- `provider-outbox-redis-password`: separate Redis ACL user `vns_provider_producer`, restricted to `bull:vns:vns-provider-text:*` and BullMQ-required commands, with no access to other queues.
- `provider-prompt-key`: 32-byte AES-256-GCM key that must be the **same key** used to seal those pending SQL prompt envelopes, not the provider credential master key. Losing or rotating it without a planned re-encryption makes the pending prompts unrecoverable.

## Operator credential-custody helper (not yet run on VPS)

The guarded `scripts/p1_09_provider_outbox_custody.py` provides three
separate operations. All require the expected operator UID, clean main
checkout and verified private host directory where applicable.

1. `--stage` creates exactly three independent private runtime files plus
   `provider-outbox-acl-candidate` (0600). The candidate contains a Redis
   password **hash**, not plaintext. It never edits `secrets/redis_acl`,
   the live Redis process or PostgreSQL. Existing files, partial staging,
   symlinks and loose permissions are refused. Operator authorization is
   required before staging any real credentials.
2. `--preflight` makes read-only PostgreSQL inquiries and verifies the exact
   0001–0048 migration ledger, disabled spending, missing producer LOGIN,
   restrictive NOLOGIN role, private secret files and hash/candidate match.
   It refuses to proceed before the 0044–0048 migrations are individually
   approved and installed. The result is not proof of the running Redis ACL.
3. `--apply` only when `VNS_P1_OUTBOX_LOGIN_PROVISION_APPROVED` equals
   `CREATE_OUTBOX_LOGIN_ONLY`: after another preflight, creates just the
   SCRAM `vns_provider_outbox_login`, inherits only
   `vns_provider_outbox_reader` with `SET FALSE`, and verifies membership.
   It does not change the Redis ACL or start a container. This is a
   production database mutation and requires fresh explicit operator approval.

A successful stage does **not** authorize a database role creation; a
successful role creation does **not** authorize modifying the running Redis
ACL; and neither authorizes a producer run or paid AI request. Do not
attempt to paste, log or send any private files, hashes or role verifiers.
If provisioning fails after side effects, preserve all files and SQL state
for read-only diagnosis rather than blindly rerunning, rotating or deleting.

Before installing the Redis ACL candidate, independently examine the
current active ACL, preserve all unrelated existing users, and review a
controlled ACL rollout and rollback. A replacement of the whole ACL with
the candidate alone would deny existing services, so it is prohibited.

The helper's tests use temporary synthetic files and mocked SQL. Live
PostgreSQL authentication, Redis ACL installation and on-host runtime
start are separate pending operator acceptance checks.

## Preflight and verification (not yet an operator command)

1. Check clean, release-pinned `main`, reviewed CI and image digest.
2. Verify productive migration ledger exactly through 0048; do not silently
   reapply an already installed migration.
3. Confirm live PostgreSQL SCRAM role, membership, direct table access denial,
   no provider budget/dispatch activation, and the expected authorized SQL
   functions. Confirm Redis _running_ ACL (not merely on-disk ACL file) and
   the private mounted-file owner/modes. Never alter the existing Redis ACL
   file or provider roles without a separate approved, rollback-safe plan.
4. Examine whether any pending SQL job contains sensitive prompt data before
   enabling publication: BullMQ data holds the **plaintext prompt** and Redis
   AOF may persist it. Review Redis retention, access, backup and deletion
   requirements before any production publication.
5. Validate the resolved Compose configuration and explicit flags read-only;
   then independently authorize any bounded, single-pass producer run.
6. Verify its SQL delivery receipts and Redis job retention, the absence of
   unauthorized duplicates, restart recovery, logs and monitoring before
   considering scheduling. No automatic schedule is introduced by this PR.

A producer run may publish a queue job but **does not authorize a paid
provider call**. The dedicated provider consumer must remain disabled until
its own separate security, cost and operator acceptance, and any later
live canary still needs explicit approval.

## Rollback / failure containment

A one-shot container exits on completion or error; it has `restart: "no"`.
Do not manually delete Redis jobs, change the AOF, revoke database roles or
erase encryption keys after an ambiguous publication: those actions can
destroy the record needed to prevent duplicate paid dispatch. First inspect
immutable SQL receipts, the retained BullMQ job and independent SQL
dispatch claims. On failure keep producer and all provider consumers
disabled, preserving database/Redis state for forensic operator review.

**Status:** Compose contract prepared and tested in CI. Production
provisioning, actual on-host secrets and Redis ACL, migration installation,
a pinned release image, operator-approved single-pass execution and live
verification are **not** established by this document. #227 and #230
remain open. IONOS backups and Beszel monitoring are operator-confirmed.
