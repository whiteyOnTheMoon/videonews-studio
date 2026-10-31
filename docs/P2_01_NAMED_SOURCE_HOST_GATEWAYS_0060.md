# P2-01: named source and independent host PostgreSQL gateways (0060)

**Status: additive repository change only; not installed on the VPS.**
Linked to #16 and P2 package A. No real feed is authorized.

## Evidence leading to this change

Operator's authenticated VPS inventory (2026-10-31, schema 0059):

- `/admin/news-sources` and `/admin/source-hosts` -> HTTP 404;
- `/admin/editorial-profiles` without a session -> HTTP 401;
- 0 source records, 0 approvals, 0 host grants, 0 publisher reviews,
  0 weighted candidates; release and PostgreSQL baseline healthy;
- browser owner positively accepted the responsive P2-09 layout.

The source/host endpoints are already implemented in
`apps/api/src/server.ts` as optional injectable handlers, but production
`apps/api/src/index.ts` does not provide either handler. The legacy
Postgres adapter calls actor-asserting functions, which **must not** be given
a shared DB writer identity for production use.

## 0060 security properties

The additive migration introduces:

- `vns.named_source_actor()`: binds active admin ID and matching
  authentication version to the physical PostgreSQL `session_user`
  via the DBA-only `vns.editor_db_principals` mapping;
- `vns.named_source_read()` / `vns.named_host_read()`: per-human,
  revocation-aware read gateways;
- `vns.named_source_commit(...)` / `vns.named_host_change(...)`:
  per-human DB identity resolved server-side, preserving the existing
  atomic CAS/source audit and the two-distinct-humans host-grant check.

The named client is granted EXECUTE on these five narrow gateways only,
**no direct source/host table writes**, and no direct EXECUTE on the
old actor-asserting functions. SQL-level 0023 still rejects one human
approving both a source and its host. A second account owned by the
same human is not an acceptable substitute.

## Offline CI

`db/tests/0060_named_source_host_admin_gateways.test.sql` runs with
separate synthetic PostgreSQL LOGINs and verifies:
source creation and approval with audit, unchanged source revision CAS,
two-person host separation, host grant CAS, source/host reads, revocation
and the absence of direct table/legacy function access.

`db/scripts/test_migrations.sh` now applies and reverts 0060 after 0059
inside a disposable isolated PostgreSQL container, twice. Nothing is
applied to the VPS by GitHub Actions.

Existing status scripts remain **scoped to 0059**. They recognize the
new 0060 file in the repository but still require **exactly the installed
0059 database manifest** until a separately reviewed 0060 rollout.
A new controlled 0059 -> 0060 database migration/runbook and a revised
P2-A acceptance check are required before activating any new handler.

## Still required for runtime integration

1. A separately reviewed **request-scoped** source/host API adapter using
   the existing personal PostgreSQL login session factory, not a shared
   privileged pool. Compare the session's bound actor with the authenticated
   editor identity. Register the handlers in `index.ts` behind distinct
   default-OFF operator flags with bounded admission, and prove unauthed,
   revoked and forged-actor negative tests.
2. Provision the read-only source/host web flags independently; preserve
   Cloudflare Access, CSRF and session security.
3. CI test new API container against disposable PostgreSQL and review an
   exact digest, then controlled 0060 schema rollout and API-only rollout
   with documented rollback and unchanged publication gates.
4. Personally verify 3–5 exact feed endpoints and usage terms; add them
   initially as `pending`. An _independent human_ reviews each host.
   Only then admit polling and prove scheduler/queue/ingestion/projection,
   source independent ranking, reasoned editor reviews and admin visibility.

**Not evidence of** rights clearance, productive source ingestion,
second independent human, real feed access, video production or publication
authority. IONOS backups and Beszel monitoring are already operator-accepted;
this change does not touch them.
