# P2-02 – atomic PostgreSQL feed commit admission (0033)

This change strengthens the **existing opt-in one-shot feed observer**. It does
not activate a scheduler, approve a real source or deploy any VPS migration.

## Database and worker integration

Migration 0033 adds two SECURITY DEFINER functions:
- `vns.claim_feed_poll_authorized(jsonb,integer)`
- `vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text)`

The narrow `vns_feed_poll_writer` role loses EXECUTE on the legacy claim/commit
functions and receives EXECUTE only on their guarded replacements.
`vns_feed_source_authority` is NOLOGIN and may invoke the pre-existing
bounded legacy SQL implementation inside a guarded transaction.

Both guarded functions check the complete nine-field source record against
the current database snapshot and verify independently audited host approval.
The commit function additionally uses the **current complete source registry**
to reject metadata URLs under more-specific child scopes, including newly
blocked or pending scopes omitted from a stale Worker file.

Admission, scope evaluation, lease verification and candidate writes occur in
the same PostgreSQL statement and hold governance row locks through commit.
Concurrent revocation cannot slip between the final authorization and the
article insert. The one-shot worker sends the full approved source record
as a bound JSON parameter, and its startup session-identity attestation
rejects roles with direct EXECUTE on legacy write functions.

Offline fixtures continue to use their original non-runtime port contract.
The new guarded path is selected **only** when
`VNS_FEED_RUNTIME_ENABLED=true`; all previously required operator gates
remain mandatory. No model, news service or access key is embedded in code.

## Tests and rollback

The disposable PostgreSQL test
`db/tests/0033_guarded_feed_commit.test.sql` checks the separate personal
source and host approvals, idempotent lease/commit, blocked nested URL
scope, legacy function denial and host revocation after acquiring a lease.
Migration up/down now joins the existing two-cycle CI migration suite.
The worker store has separate tests for guarded SQL selection, unknown
source rejection and interval mismatch.

Rollback first requires stopping the feed writer. Applying the down
migration restores the legacy grants; therefore production rollback must
retain the observer **disabled**, otherwise that restoration weakens this
security boundary. Never run it automatically or while an active feed
runtime is writing.

## Not solved

A source can be revoked **between the pre-HTTPS admission and the actual
network request**. A worker must not claim that the network boundary offers
an absolute instantaneous no-request guarantee. A transport lease, bounded
revocation window, or a stricter network policy must be designed for that
requirement. The atomic **database write** guarantee is narrower and does
not rely on a network response.

The Worker still reads a static file. Dynamic signed Admin DB export,
pinned publisher key, independently protected monotonic revision anchor,
safe registry reload, separate host reviewer enrollment, continuous
scheduler, monitoring and VPS recovery proof are still outstanding.
No P2 issue is considered production-accepted by this migration alone.
