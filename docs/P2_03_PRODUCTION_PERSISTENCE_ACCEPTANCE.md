# P2-03 — Read-only production persistence witness

**Status:** source code and disposable CI only. Does not authorize live feeds, projection, publication, SQL writes, queue edits, checkpoint resets or source-right changes. This is one part of the P2-03 (#18) acceptance procedure, not a production PASS by itself.

## Scope and prerequisite

P2-03 has a CI-proven worker/PostgreSQL/Admin path for synthetic, separately reviewed sources, including conservative 48-hour all-member deduplication and immutable article evidence. The actual USGS-only P2-02 canary at source/host revision **10/10** failed at `metadata_commit`; the follow-up URL decoder fix was installed at VPS release `aa55886b906d78d95070041637f23e09045957d4`, but no successful USGS candidate commit or authorized projector run has yet been evidenced. Newer P2-03 GitHub code **must not** be treated as a retroactive successful live feed run.

This witness only connects to the *existing* healthy Compose PostgreSQL using `psql` under the bounded `PGOPTIONS` flags `default_transaction_read_only=on`, `statement_timeout=10000`, and `lock_timeout=3000`. It requires the pinned clean GitHub release, `main` and operator `ap` (UID 1000), then runs **one** aggregate read. No raw article URL, article title, SQL exception, source secret, server address, personal name or publisher content is logged. It does not read private checkpoints or the Redis queue; their separate independent checks remain mandatory before any live action.

## Run only after the operator installs the corresponding reviewed main release

```bash
(
  set -euo pipefail
  cd /home/ap/www/videonews-studio
  SHA="$(git rev-parse HEAD)"
  test "$(id -un)" = "ap"
  test "$(git branch --show-current)" = "main"
  test -z "$(git status --porcelain)"
  python3 scripts/p2_03_projection_readonly_evidence.py \
    --expected-sha "$SHA" --source-id usgs_news
)
```

**Important:** This is a diagnostic and does **not** validate that `SHA` was reviewed. Pin the exact GitHub merge SHA externally before syncing or operating the VPS; do not use the dynamic lookup alone as an authorization to deploy or start a feed.

## Interpreting results

- `awaiting_p2_02_persistence`: zero committed feed metadata for the named source; **no projector or live P2-03 evidence**.
- `awaiting_or_incomplete_projector`: eligible feed records exist but projected event mappings are absent/incomplete; investigate the gated projector and any immutable metadata conflict before authorizing a single pass.
- `awaiting_multisource_duplicate_evidence`: some article/event mappings exist but **no event with two distinct source IDs** currently includes the named source. A lone USGS item cannot prove cross-source deduplication. Distinct IDs are **not** independently reviewed publishers.
- `awaiting_ranked_admin_evidence`: mapped cross-source events exist but no current-profile metadata ranking has been recorded. Profile thresholds can legitimately exclude a source; do not weaken them merely to create a PASS.
- `requires_named_admin_and_provenance_review`: aggregate PostgreSQL prerequisites are visible. The operator must still verify the real personally authenticated Admin GET, live source rights, immutable article-to-event identities, publisher provenance and restart behavior. This status is **not** a completion verdict.
- `blocked_schema_or_source_approval` or `blocked_persistence_invariant`: stop and investigate; do not mutate SQL, reset a lease, replay a failed job or relax an authorization guard to satisfy the test.

The output includes `event_window_violations` for events containing the source. A legacy event created before migration 0058 may legitimately be flagged; the tool intentionally does **not** alter or repair historical evidence. `immutable_metadata_conflicts` flags canonical-URL collisions that disagree on source, headline or publication time. `publication_violations` must always be zero. All outputs are aggregate counts, not evidence that a particular publisher's content was licensed or independently verified.

## Remaining operator-dependent acceptance

1. Separately recheck actual signed 10/10 source/host approvals, PostgreSQL anchor/checkpoint equality, intact failed jobs, lease eligibility, fresh queue slot, producer/consumer identity and the current reviewed release.
2. Authorize and execute **one** fresh USGS P2-02 observation only under its exact, previously reviewed, single-source operator acknowledgment; observe a successful committed candidate count. On any `metadata_commit` failure, stop and do read-only diagnostics. Never run a second poll to "force" data.
3. After P2-02 persistence, separately authorize a one-shot **DB-only** projector for an existing permitted source using the separately held `vns_feed_project_login_...` account and `feed-project-once` overlay. Never start the continuous projector as a shortcut.
4. Run this read-only witness again, then confirm source IDs and multi-source grouping against permitted real evidence; verify idempotence through an independently approved projector replay (a replay that returns 0), **not** by replaying feed HTTP.
5. Verify the actual personal Admin login and the durable ranking candidate page; the event must be metadata-only, show an explanation and `approvedForPublication=false`. Confirm that permission revocation removes it from the admin reader without deleting historical evidence.
6. Document the actual time, release SHA, authorized source, aggregate counts, event/URL identity proof handled privately, peer review and restart/failure behavior. Close #18 only after those operational checks are witnessed.

No real-source rights, verified claims, independent fact checks, durable event equivalence across languages or publication authority are implied by the script or by CI.

## CI verification

`scripts/test_p2_03_projection_readonly_evidence.py` mocks every system call and validates SHA, source ID, read-only query flags, tamper rejection and explicit non-publication status. The disposable `scripts/ci_p2_integrated_ports.mjs` test also executes **this same SQL** against its actual temporary PostgreSQL state after Redis/BullMQ feed commit, cross-source event projection, current-profile ranking and personal Admin API handoff. It expects exactly one source article in a three-article/three-source event, one unpublished ranked event and no 48-hour/immutable-data violations. The GitHub runner uses synthetic domains and identities only.
