# P2-01 – Live signing-key trust policy guarded by the independent anchor

**Status: merged code is not VPS admission.** This increment fails closed until
an operator separately configures a dedicated, TLS-verified independent
PostgreSQL authority with both source-export high-water and signing-key
trust-policy high-water functions. It does not provision that authority.

## Runtime protection

All feed contexts, including the standalone one-shot observer and the
persistent consumer, now enforce these additional requirements:

- `VNS_FEED_TRUST_POLICY_APPROVED=true` after personal review of the
  currently independently pinned public Ed25519 key and external authority.
- `VNS_FEED_TRUST_POLICY_REVISION=` followed by an **explicit**, positive,
  canonical decimal integer; there is no implicit revision 1 or bootstrap.
- The actual TLS-authenticated anchor login must have **EXECUTE** on both
  `vns_source_anchor.advance(bigint,bigint,text)` and
  `vns_source_anchor.advance_trust_policy(bigint,text)`, but no SELECT or
  direct UPDATE on either high-water table, no privileged administrative role.
- Before any worker source checkpoint acceptance or feed network access, the
  pinned public Ed25519 key is fingerprinted and included in the versioned
  SHA-256 trust-policy digest. The external monotonic authority must accept
  exactly that revision and digest. A replacement key at the same revision,
  stale policy revision, missing authority function, permission error, TLS
  failure, malformed result or remote outage **stops** the feed runtime.
- No private signing key is read. The existing signed export verification,
  independent approved-host allowlist and separate source-revision high-water
  remain required.

The initial live profile supports **one** already pinned Ed25519 key in a
single epoch beginning at source revision 1 and host revision 1. **Key
rotation across multiple epochs is not yet a live operator function.** A
future rotation cannot be activated merely by changing
`VNS_FEED_TRUST_POLICY_REVISION`: it requires a separately reviewed,
explicit nonoverlapping key-epoch configuration and tests first.

## Independent authority is an external operator responsibility

The schema `db/independent-anchor/003_trust_policy_admission.sql` is
deliberately **not** a normal application migration. Its remote high-water
row must be **bootstrapped independently using the exact pinned policy
digest**, and its authority role must be administered outside the publisher/
worker and production backup rollback domain. The existing disposable CI
SQL tests prove rejection of replay and same-revision equivocation; they do
not provide a production database or TLS certificate.

Existing approved source rights, staging transfer, importer inbox, source
checkpoint, Redis access and publishing authorization are unchanged by this
increment. All Compose profiles remain disabled by default; trust-policy
revision defaults to `0` and is therefore refused.

**No changes to VPS, IONOS backups, Beszel, real sources, network egress,
PostgreSQL roles or the product admin interface are made by merging this
code.** Do not claim P2 completion based on CI alone.
