# P2-01 – Existing host grant reconfirmation (0062, default OFF)

## Why signing is currently refused

On 2026-11-04 the personally reviewed source registry was at revision **10**
(USGS new exact feed `https://www.usgs.gov/news/149248/feed`) while the
approved host array remained at revision **7**. The latest grant audit for
NASA/NOAA/USGS was bound to **source revision 8**. The SQL export function
`vns.read_approved_source_export()` correctly refuses a grant whose audit
revision does not match the current source snapshot.

The publisher, stage, worker inbox and private checkpoint remained 8/7 with
valid, matching Ed25519 signatures. The shared-domain SQL source anchor was
also 8/7. No recovery reset is needed.

## Governance fix, without revocation

Migration `0062_host_reconfirmation.up.sql` modifies **only** the existing
`vns.admin_change_source_host_approval` SECURITY DEFINER implementation and
appends a schema migration record. An explicit personal `renew` command:

- Requires the unchanged current source revision and host revision (CAS),
  row locks, authenticated administrator, a reason of 20–300 characters,
  a still-approved existing host, a strictly *older* last positive grant,
  and an approved source on that host.
- Reuses the mandatory **separate human** source-reviewer check, or the
  existing explicitly DBA-authorized **single-owner physical-login** policy.
  The latter is never activated by this migration.
- Appends a new immutable audited `grant` event with the **current source
  revision** and its actual review model and reason; it leaves the approved
  host array exactly unchanged. Repeating the renewal for the same source
  generation is forbidden.
- Keeps both the atomic signed export and the database feed guard strict:
  they still require the latest `grant` to match the exact source revision.
  A renewed host cannot automatically authorize a feed scheduler.
- Rejects an old or forged principal, a revoked host, missing review,
  stale source revision, stale host CAS and duplicate renewal.

The personal Admin UI offers **both** an explicit renewal and a separately
selectable revocation for approved hosts; there is no implied permission
to renew on page load or in a background task.

After human renewal of the **three** existing hosts, the expected host
revision is **10**. Only then may the existing dedicated publisher produce
a newly signed 10/10 export and the separately guarded stage-refresh helper
transfer **8/7 → 10/10**. The old stage/inbox/checkpoint and SQL anchor are
never overwritten as a side effect of the governance migration.

## Exact VPS rollout stages

**1. Code release.** Merge only after real disposable PostgreSQL integration,
monorepo tests, the signed-stage UID CI and independent review have passed.
The operator pins the resulting full `main` SHA, fast-forwards a clean tree,
and builds new API/web/worker images but does not start source/host writes.

**2. Schema preflight, separately authorized.** On an already pinned
release (as Unix user `ap`), run:

```text
python3 scripts/p2_01_schema_0061_to_0062.py --status --expected-sha <PINNED_MAIN_SHA>
python3 scripts/p2_01_schema_0061_to_0062.py --preflight --expected-sha <PINNED_MAIN_SHA>
```

Preflight is read-only; it expects exact installed schema 0061, source revision
10, host revision 7, three approved sources/hosts, each latest host grant
still tied to source revision 8, anchor 8/7, valid named-personal grant
privileges, no published feed rankings and no feed/publisher/transfer
containers. It never reads signing secrets.

**3. One-time additive database migration.** After independent operator
approval and an existing confirmed backup, with the exact code SHA pinned
and no active feed services:

```text
VNS_P2_0062_OPERATOR_APPROVED=INSTALL_EXPLICIT_HOST_RECONFIRMATION_SCHEMA_ONLY \
VNS_P2_0062_EXPECTED_SHA=<PINNED_MAIN_SHA> \
python3 scripts/p2_01_schema_0061_to_0062.py --apply --expected-sha <PINNED_MAIN_SHA>
```

The helper compares both source/host/audit/anchor content digests across
the transaction, refuses retry if schema 0062 is already present, and
does not touch source data. A failed or ambiguous apply must be diagnosed
using `--status` and DB evidence, **never blindly retried or rolled back**.

**4. API/web deployment.** Only after checking the live DB schema and
reviewed operator flags, roll out API and web images with the same SHA.
Do not deploy only the admin UI against schema 0061; that database would
correctly refuse renewal commands.

**5. Three personal decisions.** Open the existing authenticated
**Separate Host-Freigaben** Admin UI. For each of NASA, NOAA, USGS, independently
review current source rights and choose `Freigabe für aktuelle Quellenrevision
erneuern`, give a 20–300 character real justification, and save exactly once.
Never use `widerrufen` as a workaround. If a write is ambiguous, reload
and inspect host revisions and the immutable audit before deciding whether
anything further is necessary. Expected progress: 7→8→9→10, with each latest
host audit `grant`, `source_revision=10`. A successful UI response is not
evidence of the underlying source's legal license.

**6. Sign, stage, import, anchor.** Independently recheck the SQL export and
sign one snapshot using the least-privilege dedicated publisher; stage using
`scripts/p2_02_signed_source_stage_refresh.mjs` with the exact expected
post-review 10/10, then import via the networkless worker UID. Only afterward
may an explicitly operator-approved feed observation advance the existing
source high-water and checkpoint; never erase them or old NOAA events.

A permanent scheduler and video publication remain **OFF**. The same-VPS
anchor remains within the same database backup/restore trust domain and is
not independently protected against VPS compromise.

## Test coverage and incompatibilities

- `db/tests/0062_host_reconfirmation.test.sql` performs real PostgreSQL
  tests under fabricated personally bound sessions and rolls back its
  synthetic changes.
- `db/scripts/test_migrations.sh` migrates and rolls back 0062 twice
  in disposable PostgreSQL, leaving production data untouched.
- API/BFF validation and React UI tests exercise the new explicit action.
- The signed staging CI verifies 8/7→10/10 and rejects old/intermediate host
  revisions, wrong signer, unrelated source changes and changed checkpoint.
- Older intentionally pinned **0061-only** operator scripts may refuse
  after migration 0062; use the explicit 0062 status helper for this stage.
