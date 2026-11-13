# P3-14 — Offline duplicate-motif detection for reviewed candidate previews

## Purpose

A keyword-matching library can choose several highly similar visuals, even
when their provider IDs or filenames differ. P3-14 adds a conservative
**visual similarity warning** for locally quarantined assets. This is an
incremental, offline similarity heuristic — **not** a general AI vision
model, semantic scene verification, copyright determination, or
publication approval.

## How it works

1. The existing private P3-13 board first verifies the episode's
   quarantine receipt, SHA-256, private path, current owner/permissions
   and non-symlink local media file. The receipt must match the candidate
   source's original episode scene and motif ID.
2. Every verified **local** JPEG/PNG/video is decoded through local FFmpeg
   to an intentionally tiny 9×8 grayscale pixel grid; a still contributes
   one grid, while an MP4 contributes three sampled frames near the
   beginning, middle and end. FFprobe bounds video duration to 0.25–900
   seconds. Input size is bounded by the previous 48 MiB quarantine cap.
3. A horizontal difference hash (dHash, 64 bits), approximate brightness
   and contrast are computed. The detector avoids comparison of nearly
   featureless frames, which otherwise produce misleadingly similar
   hashes. The threshold is deliberately strict; **false positives and
   false negatives remain possible**. Multiple matching frame samples
   are required when comparing two videos.
4. Source pairs with the *same SHA-256* are flagged as
   `EXACT_FILE_DUPLICATE`; sources with different SHA-256 values and
   unusually similar fingerprints are flagged as
   `POSSIBLE_VISUAL_NEAR_DUPLICATE`. These findings are reported across
   distinct scene IDs and alternatives within a scene.
5. The offline HTML board displays the counterpart's original candidate
   ID and scene next to each possible duplicate and shows the number
   of local media files inspected. Candidates without downloaded,
   hash-verified media have **not** been visually assessed.
6. The editor manually decides if two assets actually depict the same
   underlying motif or merely look alike. dHash **never** silently
   removes, selects, redownloads or approves an asset.

The private board now explicitly warns of suspicious **same-byte reused**
clips even if they arrived under different provider IDs. A 15-second NASA
ozone evolution and a different animation with a similar color map may
both produce near-matches, even though they show different scientific
dates. Their original data labels and observation periods must always be
reviewed by a person.

## Usage

On the P3-14 review worktree, run the same P3-13 command:

```bash
node scripts/p3_media_review_board.mjs \
  /absolute/private/workspace/post-editorial-asset-library.json \
  /absolute/private/workspace \
  --receipt=/absolute/private/workspace/quarantine-receipt.json
```

The command adds visual warnings to the private
`episode-media-review-board.html`. It neither makes external API
calls nor writes visual fingerprints to a public endpoint. It does
not provide usable footage without the earlier controlled P3-12
quarantine and separately documented human approvals.

No receipt means **zero** visual samples and zero detected pairs; the
board must not report that an undownloaded candidate has been inspected.

## Limits / next iteration

- dHash is robust to modest scaling and compression changes, but not
  general camera shifts, temporal edits, large crops, text animations,
  scene changes or inverted color; false negatives remain.
- Some distinct scientific images share a visual layout, which can
  result in false positives. The finding requires human review rather
  than automatic rejection.
- Three video samples are more representative than a single poster
  but do not prove the absence of a repeated shot anywhere in a clip.
- Rendering chronology, visual fit to spoken narration, full-source
  scientific meaning, third-party rights and licenses are not verified
  by a fingerprint. Source audio remains excluded at the renderer.
- This is an **operator-only private** feature. Production research
  workers, live provider downloads and public video uploads are not
  enabled by this change.
- Full preview footage evaluation and a later learned semantic
  image/video-to-narration model are separate future improvements.

## CI

Offline synthetic tests exercise actual H264 FFmpeg frame extraction,
checksum mismatch refusal, 64-bit dHash popcounts, near matches in
multiple frames, exact byte duplicates, unrelated images, low-detail
false-positive suppression, and the private board's cross-scene
warnings. The existing P3 episode media proof, publication gates and
Piper/cinematic codec tests are unchanged.

**Branch order:** P3-14 is stacked on P3-13 (#534), P3-12 (#532),
P3-11 (#530), P3-10 (#528), P3-09 (#526) and P3-08 (#523). No
out-of-order merge or VPS deployment.
