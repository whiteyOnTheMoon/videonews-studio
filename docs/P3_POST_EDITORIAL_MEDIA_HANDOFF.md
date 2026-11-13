# P3-11 — Post-editorial media research handoff

This slice connects **a completed, curated 19-beat story** with the episode
asset library created in P3-10. It does **not** start from a raw news item or
unverified source candidate. The isolated research worker currently produces
candidate-only reports; it does not produce an approved 19-beat video script.
This is an operator-authorized, offline-first bridge, **not yet a production
worker trigger**.

## Order of operations

1. Collect independently reviewable news and science sources.
2. Produce a curated, complete 19-beat explainer story with source URLs,
   `editorialApproved=false`, `renderAllowed=false`,
   `uploadAllowed=false` and `publicationAllowed=false`.
3. Bind the story to the original candidate-only editorial report using
   exact overlapping source URLs, the exact story SHA-256, event ID and a
   named review attestation. This is a procedural record of operator review,
   **not a digital signature or independent facts certification**.
4. Generate a deterministic list of requests. Scientific scenes request
   NASA material as **scientific-source candidates**. All scenes separately
   request optional Pexels **contextual B-roll**, never as evidence for a
   scientific or factual claim.
5. Research in **four-request batches**. If no existing Pexels key is
   available, stock requests are recorded as skipped. An unavailable or
   rate-limited provider is never silently replaced by unrelated media.
6. A resumable, private episode catalogue records candidates, original
   URLs, creator/credit, provider IDs, evidence role, and skipped tasks.
   All candidate rights flags remain false; no videos are downloaded.
7. Individual license, brand, people and property checks and the operator's
   selection must happen before the P3-10 local staging, P3-09 rendering,
   and eventual reviewed-export checksum-gated cleanup.

## Named handoff attestation

The operator creates a JSON file **after** independently reviewing the
source/curated-script relationship. Required fields:

```json
{
  "kind": "post-editorial-media-research-only",
  "reviewedStoryId": "ozone-2026-explained-en",
  "storySha256": "<64 lowercase hex of JSON.stringify(parsed story)>",
  "researchEventId": "<64 lowercase hex from original editorial report>",
  "reviewerId": "a-real-reviewer-id",
  "reviewedAt": "2026-11-13T17:45:00.000Z",
  "sourceLinkReviewed": true,
  "allowMetadataResearch": true,
  "allowMediaDownloads": false,
  "allowPublication": false
}
```

The separate research report must be the genuine `EditorialReport`:
`version=1`, `approvedForPublication=false`, at least one source URL
identical to a curated source URL, an event ID and the
`offline_metadata_only` decision marker. This association **does not**
mean the report approved or fact-checked the finished story.

**Do not fabricate a report or the attestation to make this CLI run.** The
current hand-written ozone example may not have a matching, stored
editorial-worker report; in that case the bridge correctly refuses, and
the existing manual P3-10 story-only planning CLI remains available.

## Private CLI

The required story, report, attestation and cache paths must be absolute.
The asset root must already exist with 0700 permissions, owned by the
operator and have no symlink components.

```bash
node scripts/p3_post_editorial_asset_handoff_cli.mjs \
  /private/story.json /private/editorial-report.json \
  /private/reviewed-handoff.json /private/episode-asset-cache
```

Without `--discover`, this only writes a new private checkpoint and makes
**zero network calls**. Add `--discover` to fetch at most four JSON metadata
responses using the official NASA Images API and, only when already
authorized with `PEXELS_API_KEY`, the Pexels Video API. The API key is not
written into the checkpoint.

To resume the same episode, supply:

```bash
node scripts/p3_post_editorial_asset_handoff_cli.mjs \
  /private/story.json /private/editorial-report.json \
  /private/reviewed-handoff.json /private/episode-asset-cache \
  --discover --resume=/private/episode-asset-cache/ozone-2026-explained-en-XXXXXX
```

Copy the actual workspace path printed by the first invocation; the
`XXXXXX` shown above is **not** a literal path. The CLI rejects mismatched
story digests, research event IDs, reviewers, episode IDs and unsafe
workspaces. A batch of four search operations may return zero candidates;
the UI should show coverage gaps rather than fabricate visual matches.

## Provider policy

- NASA Images API: metadata-only science candidates, with original data date,
  credit and any third-party rights verified independently.
- Pexels: existing API credentials only, bounded metadata search. Pexels
  prohibits systematic copying, standalone redistribution and unauthorized
  media datasets; stock footage is context, not supporting evidence.
- Pixabay: no automated systematic harvesting or bulk download. Its API
  asks for result caching and restricts automated calls.
- Unsplash: no naive local downloader. Its API has mandatory hotlinking
  and download-event tracking rules. Build a compliant implementation
  separately if required.

References:
- https://images.nasa.gov/docs/images.nasa.gov_api_docs.pdf
- https://www.nasa.gov/nasa-brand-center/images-and-media/
- https://www.pexels.com/api/documentation/
- https://help.pexels.com/hc/en-us/articles/900005880463-What-are-the-Terms-and-Conditions
- https://pixabay.com/api/docs/
- https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines

## CI and deployment guard

CI uses synthetic JSON provider results, a synthetic curated story and a
synthetic editorial report; there are **no live provider calls and no
downloads**. It verifies source mismatch refusal, storyboard checksum,
explicit opt-in, no asset/publishing grants, no leaking the API key,
per-batch limits, source-vs-stock roles, deterministic resume and
cross-episode refusal.

This development branch is stacked on P3-10, P3-09 and P3-08; do **not**
merge or deploy out of order. No production research worker, database
schema, web API, renderer or upload route is enabled by this slice.
