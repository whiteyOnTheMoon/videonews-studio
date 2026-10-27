# P2-01 – Atomic PostgreSQL source snapshot → Ed25519 signed worker export

## What is integrated

Migration 0034 provides `vns.read_approved_source_export()`, one locked
PostgreSQL statement combining the currently audited source registry and
independently reviewed host grant registry. It rejects missing grants,
missing or revoked host audit decisions, and grants tied to stale source
revisions. The dedicated `vns_source_export_reader` NOLOGIN role receives
**EXECUTE only**, not SELECT on the admin tables.

`publishApprovedAdminSourceFile` accepts that exact SQL result and passes
its source/host snapshots through the existing strict export validator and
Ed25519 signer. The publisher's private directory uses the existing
0600 temporary-file creation, fsync, atomic rename, and directory fsync.
It requires caller-provisioned signing authority; it does not generate
private keys, grant hosts, or contact network sources.

The real isolated CI now covers:
1. Two synthetic distinct editor identities and the audited source+host grant.
2. Restricted PostgreSQL feed and distinct export reader logins.
3. Atomic DB snapshot → signed private file → signature-verified consumer.
4. Verified source list injected into the existing BullMQ feed pipeline.
5. Persisted PostgreSQL feed candidates and non-publication checks.

SQL migration tests cover empty grants, privilege isolation, incomplete audit,
and two complete up/down cycles. Synthetic filesystem tests cover wrong
signatures, malformed/mismatched snapshots and fail-closed database errors.

## Remaining rollout blockers

- The **production** feed observation entrypoint has not yet been switched
  from its manually mounted reviewed registry to this signed export.
- The publisher still requires a dedicated deployed process, provisioned
  signer login, private signing key kept outside worker containers, and
  secure distribution of the signed artifact.
- The consumer must use an independently pinned Ed25519 public key and a
  **separately controlled, monotonic revision anchor** at runtime. The CI
  anchor callback is deliberately synthetic; it is *not* external proof.
- Publisher/consumer 0700 private directories and separate Docker UIDs
  require an explicit cross-boundary transfer mechanism, not shared write
  permissions or root shortcuts.
- A host or source revocation after a signed export still needs safe worker
  reload. The guarded PostgreSQL functions from migration 0033 protect
  final metadata persistence; they do not eliminate a race immediately
  before an HTTPS request.
- Real sources, rights approvals, the continuous Scheduler, VPS migration
  review, backup/restore and alert delivery remain operator-controlled.

No provider, publishing feature, production database, or VPS is activated
by this change. P2-01 and P2-02 remain open until full acceptance.
