# P2-02 — USGS signed source revision 8/7 → 10/7

**Read-only VPS evidence, 2026-11-04:** The personally approved admin registry is at source revision **10** (USGS approved with exact direct feed URL `https://www.usgs.gov/news/149248/feed`), host revision **7** (www.usgs.gov approved), with exactly three approved sources. The independently maintained same-VPS SQL anchor remains at **8/7**. Publisher, handoff stage, worker inbox and worker checkpoint are all still **8/7**. Their file ownership/modes were independently enumerated; this inventory alone does not constitute signature validation.

The direct USGS endpoint was observed with HTTP 200, `application/rss+xml`, 27,935 bytes and 20 usable metadata candidates under the revised parser. This is **not** copyright approval, independent news corroboration or publication authorization.

## Monotone, explicitly operator-approved handoff

**Never re-run** the one-time stage creation helper (`p2_01_signed_handoff_stage.mjs --install`), since stage/inbox/checkpoint now exist. Never delete/reinitialize the checkpoint, reset the anchor, edit signed JSON, manipulate the signing key or remove old Redis failure records.

1. **Preflight.** Confirm clean pinned `main`, no active or stopped P2 producer/consumer/publisher containers, source/host admin revisions 10/7, USGS metadata rights reviewed, host grant still active, and anchor high-water 8/7 with a previously approved envelope digest. Ensure the source review audit and approvals are independently acceptable. No feed polling.
2. **Sign once** using the existing dedicated `source-publisher` Compose profile and restricted PostgreSQL signing role/private Ed25519 key. This existing publisher reads the atomic SQL source/host snapshot, checks independent host allowlist and writes a signed 10/7 export via fsync+rename. It must never be run with arbitrary host grants, generic credentials, remote feed egress, or with the worker's DB/Redis credentials.
3. **Check the signed publisher output** (10/7) against the DB snapshot and verify its Ed25519 signature with the _existing pinned public key_. The old stage, worker inbox and checkpoint remain on 8/7.
4. **Refresh staging only:** `scripts/p2_02_signed_source_stage_refresh.mjs` performs a root-only, SHA-pinned and explicit-approval-gated 8/7→10/7 update. It refuses any unrelated publisher, source, host or rights mutation. It compares the existing old staged signature with the worker inbox and the checkpoint's envelope hash before an atomic fsync+rename of the one 0640 group-readable handoff file. Files in the private worker inbox/checkpoint are never modified by this helper. A stale lock, unexpected owner/mode or an existing/partial temporary file is a hard stop; do not rerun blindly.
5. **Import once** through the existing networkless, restricted UID10002 `source-handoff-import` Compose profile (signature/approved-host checks, inbox monotonicity). This step is independent from the stage update. It changes only the inbox, not the SQL high-water or checkpoint.
6. **Verify/advance anchor and checkpoint** using the existing signed-source acceptance boundary with the same-VPS PostgreSQL authority. Before any queue or HTTPS poll, verify 10/7 and expected envelope digest and keep the trust-policy revision unchanged; on failure, stop and reconcile. The one-shot feed observer may update the checkpoint while starting a deliberately authorized canary; no permanent scheduler should be enabled as part of the source refresh.
7. **Canary:** only after independent inspection, run one `usgs_news` operator-approved observation with explicit flags; check candidate persistence, projection, source-authority checks, queue failure audit and Admin visibility. The existing ~10 NOAA events, historical failed job and poll leases are preserved.

## Exact scope of the staging helper

- **Only** source revision 8→10 and host revision 7→7, exactly 3 approved `nasa_news`, `noaa_news`, `usgs_news`, and the unchanged set of www.nasa.gov, www.noaa.gov, www.usgs.gov hosts.
- For NASA/NOAA, the approved records must be byte-equivalent at a field-value level. For USGS, only the existing old feed URL → `https://www.usgs.gov/news/149248/feed` and `reviewedAt` may change.
- Publisher and previous stage must be Ed25519-signed by the currently pinned public key. The previous stage must match the private worker inbox byte-for-byte and the old worker checkpoint's digest. The latter is only a local coherence check, not a substitute for the independently protected authority.
- Run as root against exact pinned code; no network, SQL, queue or private-key read by the stage helper. The source signing container, not this helper, performs publication.
- On successful refresh, only the **staged file** changes. No retroactive source clearance, new scheduler or automatic redirect following.
- Deployment remains a separate operator action; GitHub CI uses only fabricated keys and URLs.
- Because the SQL anchor is hosted on the same VPS, it shares the server/restore compromise domain and is **not** anti-rollback protection from a compromised server.

## Bounded operator interface

After a verified signed publisher 10/7 exists, the helper has these root-only subcommands (all require matching `--expected-sha` and clean `main`):

```text
sudo node scripts/p2_02_signed_source_stage_refresh.mjs --preflight --expected-sha <EXACT_RELEASE_SHA>
sudo node scripts/p2_02_signed_source_stage_refresh.mjs --install --expected-sha <EXACT_RELEASE_SHA> --approval REFRESH_VERIFIED_USGS_STAGE_8_TO_10_ONLY
sudo node scripts/p2_02_signed_source_stage_refresh.mjs --verify --expected-sha <EXACT_RELEASE_SHA>
```

This document is a **sequencing contract**, not permission to execute steps 2–7 without verifying production state.
