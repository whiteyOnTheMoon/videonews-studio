# P3-15 — End-to-end synthetic private cinematic export proof

## Goal

P3-08 through P3-14 have been merged **in dependency order** into
`main` (last merge SHA: `2e1d6db0e9faa0c9aedd29b0fe19b5b983acbef1`).
P3-15 verifies that these separately built modules interoperate.
The test uses **only locally generated FFmpeg videos and a synthetic
sine-wave narration track**. It never downloads real NASA, Pexels,
Pixabay or Unsplash files, contacts remote APIs, publishes content or
asserts editorial rights.

## End-to-end test steps

The `scripts/p3_integrated_private_preview.test.mjs` fixture performs:

1. Create a 19-visual-beat science-explainer outline and episode media
   plan. Register two unapproved metadata candidates with synthetic
   NASA/Pexels provider labels, using distinct stable motifs.
2. Generate local 640×360 H.264 test sources (seven seconds and five
   seconds) with an **embedded source audio track**. The downloader
   receives those bytes from a purely injected, local fake fetch
   implementation. The official-provider URL strings are structural
   test inputs only; **no network request is made**.
3. Prove that download consent defaults to false. Explicitly authorize
   the *synthetic-fixture-only* quarantine operation and hash the two
   copied files. Both remain unapproved and not renderable.
4. Create the P3-13 private offline review board with actual local
   FFmpeg-generated JPEG thumbnails and P3-14 video fingerprints.
   The board never fetches external preview images.
5. Prove that a missing rights review blocks cinematic manifest
   creation. The test then uses explicitly named **CI synthetic-only**
   fixture review evidence — not NASA/Pexels clearance — to produce
   a private manifest with two independent motifs.
6. Verify the actual cinematic planner: a short four-second moving
   insert in editorial beat 15 (with six seconds of original diagram
   tail), plus one four-second video spanning editorial beats 18–19.
   All durations are in exact 24fps frame counts. Photo-backed beats
   remain reserved and cannot be overwritten.
7. Encode the cinematic overlays and diagram tail, concatenate
   exactly **336 video frames / 14 seconds**, and mux a single
   uninterrupted, synthetic PCM-to-AAC narration track.
   Verify **one H.264 video stream and one AAC audio stream** in the
   completed 1280×720 private MP4. Source video soundtracks cannot
   leak through this export.
8. Prove that an invalid expected MP4 SHA-256 refuses cleanup and
   keeps temporary media. After explicit cleanup approval and a
   verified final export, delete only the one temporary episode
   workspace. Keep the final MP4 and the independent private
   provenance receipt with source IDs/hashes.

This is a synthetic **14-second integration excerpt**, not a full
19-scene episode and **not a release authorization**. The existing
P3 full-English Piper CI separately verifies synthesized speech,
all 19 graphics, and its own three-second H.264/AAC smoke.

## How to run the standalone proof (private worktree only)

With FFmpeg, ffprobe, librsvg2-bin and Node.js 22 available:

```bash
node --test scripts/p3_integrated_private_preview.test.mjs
```

Its working tree lives in a disposable, private temporary directory
and is removed by the test. The script makes no provider network calls
and does not read or modify the real NASA ozone video under
`~/.local/share/vns-visual-assets`.

## Real-footage operator review remains a separate gate

The previously inspected NASA Ozone Watch 2026 animation has SHA-256:

`adfd7a539766cb06c71e6bdf3fd87d9c646c0d8e4f11913cb5922cd8a46289bb`

and measured duration **15.166667 seconds**. Three sample frames
have been visually inspected by the operator. However,
`INSPECTED_UNAPPROVED` must still be honored until the individual
source conditions, attribution, date range and any third-party rights
are separately reviewed. Do **not** copy the synthetic test's
`rightsApproved=true` flags to actual media.

Before a full private VPS episode with genuine footage:

- Verify source-specific rights (including voice model commercial
  licensing, if distribution is considered) and scientific date coverage.
- Select a narration beat whose duration fits a single use of the
  original video, without stretching or looping.
- Retain the original NASA date/legend/timeline on-screen. The P3-09
  lower-third overlay currently obscures portions of scientific
  animations; **the overlay layout still needs redesign and a real
  visual inspection**. Passing this E2E test does not resolve that.
- Audit each stock candidate's authentic provider URL and visual
  relevance. Signed Pexels CDN video links remain fail-closed.
- Render and listen to a full private episode on the VPS **without
  changing the production worker or publishing anything**. Record
  exact final MP4 SHA-256, inspect beginning/middle/end and ensure
  narration continuity and source credits.
- Only then authorize individual temporary episode-media cleanup;
  keep provenance records outside the cache.

## CI and deployment status

The P3 episode-asset workflow runs the synthetic end-to-end test
with local FFmpeg and `librsvg2-bin` in GitHub's ephemeral runner.
The full existing Piper proof remains separate. If any new test or
lint fails, do not merge or deploy this P3-15 branch.

No production download worker, public media endpoint, YouTube
publisher, automatic real-license approval or VPS deployment is
added in P3-15.
