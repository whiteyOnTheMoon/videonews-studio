# P3-12 — Controlled media selection, quarantine and private clip handoff

This phase extends the P3-10/P3-11 episode library with **manual selection
of at most four direct media assets per acquisition batch**, separate
rights review, and creation of a private cinematic render manifest.
**No automatic news-worker downloads**, uploads or publishing are enabled.

## 1. Research and shortlist

Use the existing research-only `post-editorial-asset-library.json`
checkpoint. It contains NASA scientific-data candidates and Pexels
**context-only B-roll** alternatives. Neither provider's candidate
metadata proves rights, object identity, capture date or suitability.
The reviewer checks the source page, imagery and current provider terms,
then obtains a *specific direct-file URL* from that source.

This implementation supports only:
- NASA official media URLs served by `images-assets.nasa.gov`,
  `svs.gsfc.nasa.gov`, or `ozonewatch.gsfc.nasa.gov`.
- Pexels videos/photos served by `videos.pexels.com` or
  `images.pexels.com`, provided their source and license are reviewed.

There is **no Pixabay or Unsplash auto-downloader** in this slice.
Unsplash API hotlink/download-tracking rules and Pixabay's bulk download
and caching restrictions require distinct implementations.

## 2. Operator-authorized quarantine

Create a private 0600 JSON selection file:

```json
{
  "schemaVersion": 1,
  "operatorConsent": {
    "operatorId": "your-real-reviewer-id",
    "approvePreviewAcquisition": true,
    "allowRendering": false,
    "allowPublication": false
  },
  "selections": [
    {
      "candidateId": "nasa:EXACT-CANDIDATE-ID",
      "sceneId": "beat-04",
      "directUrl": "https://ozonewatch.gsfc.nasa.gov/ozone_maps/movies/ACTUAL-FILE.mp4"
    }
  ]
}
```

The ID, scene and direct URL must be checked against actual official
provider metadata. This is a **structural example**; the filenames and IDs
above are *not* asserted to exist. Do not change an arbitrary media URL
to make it appear to belong to a candidate.

```bash
node scripts/p3_reviewed_media_selection_cli.mjs download \
  /private/workspace/post-editorial-asset-library.json \
  /private/selection-consent.json /private/workspace
```

The CLI can also accept the standalone P3-10 `episode-library.json`.
It writes a private `quarantine-receipt.json` that records individual
bytes, SHA-256, candidate ID, source page and `rightsApproved=false`.

**Enforced limits:** max four manually selected files per call, max two
per scene, max 48 MiB per file and 128 MiB per batch. Only HTTPS,
fixed official provider CDN hosts, .mp4/.jpg/.jpeg/.png files, matching
MIME types and valid file signatures are accepted. No redirects, URL
credentials, arbitrary remote hosts, URL query tokens or symlinked cache
directories. Streaming byte limits are enforced even if the server's
Content-Length is missing or false.

Quarantine media **cannot be used by the renderer**. In particular,
download success is *not* a license grant, true NASA observation date,
motion-video codec verification, or human editorial approval.

## 3. Named separate media review

After independently inspecting the **actual quarantined file**,
checking its provider attribution, date and any third-party rights,
create a different private JSON file:

```json
{
  "schemaVersion": 1,
  "episodeId": "ozone-2026-explained-en",
  "reviews": [{
    "candidateId": "nasa:EXACT-CANDIDATE-ID",
    "reviewedFileSha256": "64_LOWERCASE_HEX_FROM_QUARANTINE_RECEIPT",
    "rightsApproved": true,
    "editorialApproved": true,
    "thirdPartyRightsCleared": true,
    "rightsReviewedBy": "your-real-reviewer-id",
    "rightsReviewedAt": "2026-11-13",
    "licenseEvidence": "Describe the actual item-level rights and attribution reviewed",
    "captureDate": "2026-09-29",
    "endSceneId": "beat-04",
    "insertFrames": 288
  }]
}
```

Dates and `insertFrames` are **illustrative**; obtain the actual capture
date and duration from the NASA source, and select an allowed story beat.
For NASA seasonal visualizations with multiple observation dates, the
reviewer must distinguish the *per-frame date range* from a single
capture date. Use appropriate on-screen language and source credits.

```bash
node scripts/p3_reviewed_media_selection_cli.mjs prepare \
  /private/workspace/post-editorial-asset-library.json \
  /private/human-media-review.json /private/workspace
```

This creates `private-cinematic-manifest.json` inside the workspace.
The manifest is checked for local path safety, byte hashes, sources,
unique motifs and required approvals. **It is still not a publication
authorization.** The P3-09 cinematic planner separately checks clip
codec, 24fps narration frame budget, full/partial scene durations,
photo-slot conflicts and overlap before private rendering.

## 4. Export and cache cleanup

The source links, contributor, license, review identity, SHA-256 and
scene mapping must be retained in the separate provenance receipt.
P3-10's `finalizePrivateExportAndCleanup` may delete only the
individual episode workspace, and only after an actual final private
MP4 hash matches an expected digest and the operator explicitly
approves cleanup. Incorrect checksums or missing approval leave
quarantined assets untouched.

## CI and phased deployment

All P3-12 tests use synthetic media bytes and injected fake HTTPS
responses; no provider endpoints are called. They test host and URL
allowlists, source and scene selection, streaming caps, wrong response
MIME, redirects, missing review, fingerprint mismatch and publication
denial. The existing full P3-09 moving-video synthetic tests continue.

P3-12 is stacked on unmerged P3-11 (#530), P3-10 (#528), P3-09 (#526)
and P3-08 (#523). Do **not** merge or deploy out of order.
