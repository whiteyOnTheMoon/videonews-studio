# P3-10 — Episode-specific temporary asset research library

## Why
After research completes, the editor should search for visual assets **per scene**
instead of downloading one repeated illustration and stretching it over an entire
episode. The science footage (NASA/NOAA) carries factual meaning; Pexels or
other stock photos/videos provide atmosphere and are **not evidence** of claims.

The first slice is deliberately independent from publishing, rendering and
the production news-research job. This branch adds an API-budgeted,
metadata-only discovery service and a private, episode-specific candidate
library with **four desired alternatives per visual beat**. Human selection,
actual media downloading and production event wiring are further work.

## Provider-specific limits (verified 2026-11-13)

| Provider | Plan | Restrictions |
|---|---|---|
| NASA Images API | Enabled in operator opt-in discovery, via official `images-api.nasa.gov/search` | Source pages and media credits recorded; review item-specific third-party rights, observation dates and soundtracks before downloading |
| Pexels | Enabled in opt-in discovery only with an **already available** `PEXELS_API_KEY` | Official API and attribution; new key issuance was paused on 2026-11-13. Current API video search is `/v1/videos/search`. Never store the key |
| Unsplash | Listed as a candidate provider but **no automatic API adapter yet** | API requires hotlinked photo URLs in results, separate download tracking and linked author attribution; automated harvesting is not acceptable |
| Pixabay | Listed as a candidate provider but **no automated batch search/download** | API says cache results for 24h, forbids systematic mass downloads and limits high-rate automated requests |

Sources:
- https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf
- https://www.nasa.gov/nasa-brand-center/images-and-media/
- https://www.pexels.com/api/documentation/
- https://www.pexels.com/api/
- https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines
- https://pixabay.com/api/docs/

This is not a blanket provider rights clearance. Content depicting people,
private property, logos or third-party creative works may require extra review.
Unverified candidates are never eligible for rendering.

## Workflow and data model

1. After the story outline and visual beats exist, call
   `buildEpisodeAssetResearchPlan(story)`. For P3 it produces 19 scene IDs
   (`beat-01` … `beat-19`), provider preference, context-scoped search
   intent, desired alternatives (4), and a download ceiling (2 per scene).
2. `discoverEpisodeCandidates(plan, ...)` performs **at most four**
   discovery requests by default and never more than six in one invocation.
   It fetches official NASA results; with an existing Pexels key it may also
   obtain stock background candidates. It does not follow redirects,
   download media or grant approvals. The remaining scenes need future,
   bounded discovery batches or review.
3. `createEpisodeMediaLibrary(plan, candidates)` keeps at most six catalog
   alternatives per beat and refuses the same provider/motif as an
   independent second scene. Store title, provider asset ID, source page,
   photographer/credit, license page, dates when known and review status.
4. A **different human review step** inspects imagery, factual match,
   license, people, trademarks and original observation dates.
   Only explicitly reviewed locally obtained media can be copied into the
   temporary cache with `stageReviewedLocalAsset()`, which requires
   individual authorization booleans and exact SHA-256.
5. After an actual private MP4 export exists and its SHA-256 is verified,
   `finalizePrivateExportAndCleanup()` requires explicit cleanup approval,
   writes a durable provenance receipt *outside the cache root*, and then
   removes only this one episode's temporary working directory. Incorrect
   checksums, absent video or missing approval **do not delete anything**.
   Original user cache files outside the episode working directory are
   intentionally not removed.
6. Long-term, the render selection can be reproduced from source pages,
   provider IDs, contributors, licenses and SHA-256. That does not guarantee
   the source is still available or that a license will stay unchanged.

## Operator-only discovery pilot (no media downloads)

A private working root must already exist, owned by the operator and 0700.
For example:

```bash
umask 077
mkdir -p -m 700 /home/ap/videonews-episode-assets
node scripts/p3_episode_asset_research_cli.mjs \
  /home/ap/www/videonews-studio/content/news/ozone-2026-explained-en.json \
  /home/ap/videonews-episode-assets
```

The optional `--discover` flag enables up to four real metadata-only NASA
queries (and Pexels queries when `PEXELS_API_KEY` is already configured).
Without the flag, the CLI **never contacts any provider**. It creates
`episode-library.json` inside a fresh, private, randomly named episode
workspace. Never put credentials or media in a repository or webroot.

## Security and publishing

- Do not run unattended provider scraping, bypass provider quotas or
  download results en masse. Manual consent is required before staging.
- Catalog entries default to `rightsApproved=false`,
  `editorialApproved=false` and `thirdPartyRightsCleared=false`.
- No clip may be reused in multiple scenes by a different crop/encode:
  retain a stable motif ID across derivatives. Pixel-level perceptual
  similarity remains future work.
- The intact Piper voice, editorial and publication gates of P3 are
  untouched. The media library does not grant permission to upload.
- The private workspace must have a non-symlink absolute path, be owned
  by the operator, and use mode 0700. The cleanup function cannot remove
  an arbitrary directory or proceed without verified export SHA.
- The initial CLI is a manual pilot, **not yet automatically triggered
  by the news-research pipeline**. That integration should happen after
  provider approvals, download quotas and review UI are implemented.

## CI scope

Unit tests use synthetic provider API responses and synthetic local media;
there are no provider network calls, API credentials or real stock downloads.
Tests cover provider separation, 19 intents, duplicate motif refusal,
review-gate refusal, hash-verified private staging, no deletion on failed
export checksums, persistent source receipts and symlink rejection.
