# P3-01 – Asset catalog provenance foundation (2026-11-08)

Related to GitHub issue #26; based on P2 MVP main commit
545e134871d816fd5158bbb31c5973c7ced3b7b8.

## Scope and existing model

Migration 0001 already created vns.assets and vns.licenses. Migration
0064 extends the existing asset rows with origin_url, creator,
license_url, license_snapshot (JSON object), content_sha256 and
rights_flags (JSON object, default empty / unknown). The existing
attribution field remains in place. The existing story_id expresses
story association, while a new vns.asset_uses relation records actual
video usage rather than guessing from the story association. A trigger
refuses links between unrelated stories.

Provenance URL fields require HTTPS, the content hash must be a
lowercase SHA-256 hexadecimal digest, and populated provenance values
cannot be silently rewritten. A correction requires a new asset identity.
The snapshot is stored evidence, not an independently authenticated
license. Flags are untrusted review metadata and never grant rights.

## Fail-closed rights and legacy data

A new or updated rights_status=cleared row requires origin, creator,
license URL, nonempty license snapshot, SHA-256 and attribution, as well
as the license and timestamp already required by migration 0001.

The new constraint is NOT VALID to avoid rewriting or deleting
pre-existing assets. Historical cleared rows lacking provenance can
remain in storage, but are not grandfathered: the
vns.asset_rights_readiness view reports BLOCKED and render_allowed=false.
Even a fully populated synthetic asset remains BLOCKED with reason
license_policy_pending. P3-02 must implement a reviewed commercial
license decision; this first schema change grants no render, upload or
publication authority. The existing rights_status column must not be
treated as a render authorization.

## Isolation, migration and rollback

This is a Git/CI-only addition. It introduces no external media API,
crawler, download, new paid service, credentials, runtime privileges,
Admin write endpoint, rendering or publication. No production schema
is changed by merging the PR.

The up/down cycle is exercised in disposable PostgreSQL 17 CI after
the existing migrations and 0063; a historical legacy-cleared fixture
is created before applying 0064 to verify that migration does not grant
rights to old rows. Tests cover malformed URLs/digests, missing
provenance, immutable evidence, video use links and the blocked
render-admission view.

The down migration refuses to discard any populated new provenance
fields or usage records. A VPS migration or rollback requires separate
operator approval and a data-preservation plan. Running the entire
historical P1 schema-down chain against production is prohibited.

## Explicit next boundaries

P3-02 (#27): reviewed license-rule decisions, including commercial
restrictions, attribution, derivatives, model/property releases and
trademark/person concerns. Only after this may a tested rights gate
ever consider allowing a render.

P3-08 (#33): integrate versioned credits, license export and enforce
negative checks at real render/upload entrypoints. The P3-01 view
alone does not protect future renderers that ignore the gate.

No asset, even with metadata marked cleared, has been approved for
real-world commercial use by this migration.
