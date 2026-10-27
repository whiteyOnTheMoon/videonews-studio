# P2-01/P2-02 – runtime source revocation gate (migration 0032)

## Actual code path

The explicitly enabled one-shot entrypoint `apps/worker/src/feed-observe-once.ts`
calls `createDormantFeedScheduler`. With `VNS_FEED_RUNTIME_ENABLED=true`,
this composition supplies `PostgresFeedSourceAuthority` to the feed poller.
The authority executes the PostgreSQL function
`vns.feed_runtime_source_authorized(jsonb)` as the narrow feed login.

The function matches all nine fields of the worker's reviewed source against
the **current** personally audited admin source JSON; it requires `approved`,
an independently granted host, and a host grant tied to the **same source
registry revision**. It reads the latest host decision from the audit table.
The feed login can execute the function but has **no SELECT grant** on the
admin source, host registry, or host audit tables.

The poller consults the authority before leasing, again just before HTTPS,
and again before candidate persistence. A denied source or unavailable
authority is recorded as a failed source with no new articles. It does not
stop other source loops. Failures still cause the existing BullMQ
single-pass aggregate to report failure; do not interpret partial results as
a successful production observation.

## Strict governance behavior

Any source registry revision occurring after a host grant invalidates
admission on that host, even if another source on the same host is unchanged.
The operator must revoke and grant the host anew using the existing
**distinct human** approval process and current source revision. A single
person and an AI are not two distinct human approvers. Do not weaken the
two-person SQL constraint to make test fixtures convenient.

A checksum alone is not a producer signature. The legacy file-based registry
remains separate; this runtime gate does **not** itself distribute source
snapshots, authenticate the publisher, or replace the trusted signed-file
checkpoint. No real provider, source, or paid model is activated.

## Remaining production blockers

- The SQL gate verifies the selected source record but not the **entire**
  source registry. A stale worker file could omit a newly blocked, narrower
  article URL scope while retaining an otherwise unchanged approved parent.
  Exact current registry/projection admission must be checked before trusting
  article URLs; this is a blocker for production activation.
- The authorization check and later HTTPS request are separate transactions.
  A revoke may race between check and transport. Likewise the last check and
  `commit_feed_poll` are not atomic. A DB-side authorized claim/commit path is
  required before asserting race-free source revocation.
- The worker still loads a static registry at process start; an atomic signed
  admin export, pinned public key, independently protected revision anchor,
  safe update/reload, rights approval and monitored failure policy are needed.
- No continuously running scheduler exists. No production credentials,
  migrations, PostgreSQL roles, VPS resources, offsite restore, operator
  approvals or real feeds have been changed or validated by this patch.
- Migration 0032 is reversible for isolated CI; deployment and rollback
  require a separately approved production change plan.

## Evidence

`db/tests/0032_feed_runtime_source_authorization.test.sql` uses two distinct
synthetic human accounts, a real grant and a revoke, tests snapshot tampering,
and proves no direct admin-table SELECT for the feed role.
`feed-scheduler-composition.test.ts` checks that revoked sources never
reach the injected HTTPS boundary or claim a feed lease in the synthetic
runtime mode. It does not constitute a VPS deployment acceptance.
