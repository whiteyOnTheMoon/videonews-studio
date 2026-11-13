# P3-18 – Authentic one-minute English ozone editorial pilot (private only)

Issue: #543. This branch is stacked on P3-17 PR #542, which depends on P3-16 PR #540. It **must not be merged independently** or deployed to productive workers.

## Editorial aim and layout

Respond to operator feedback that P3-17 information was too close to the four corners. Use cinematic FULL-SCREEN B-roll for the background, a partially transparent navy/teal overlay above it, then highly visible, independent **centrally placed** editorial graphics. Six ten-second beats / 1440 frames / 60 seconds at 1280×720, 24fps:

| 0–10s | Centered opener | "Antarctica's Ozone Hole" | Earth backdrop A |
| 10–20s | Large center metric | 25 million km² seasonal average | Same backdrop A |
| 20–30s | Large center metric | 27.1 million km² single-day maximum | Crossfade to backdrop B |
| 30–40s | Large **unobscured** scientific image in the middle | Polar vortex / dated NASA ozone map | Still backdrop B |
| 40–50s | Centered explanation | Hole area ≠ depth | Crossfade to backdrop C |
| 50–60s | Large **unobscured** scientific moving inset | Recovery / 2026 observations | Still backdrop C |

Crossfades consume 12 input frames (0.5s) per boundary, with six extra source frames from each neighbor, so narration length is unchanged. Every background is independently SHA-verified, H264 and at least 20.25/20.5 seconds. No source audio passes through. Science photo/video is fit into a **720×405** central window, never cropped, and not dimmed by the atmospheric overlay. This is the actual requested background/gradient/foreground video style, not the P3-16 rigid side rail.

English script and per-scene sources are in:
`content/news/ozone-2026-minute-editorial-pilot-en.json`.
The editorial narrative is original (118 English words). It is an editorial **private review**, not published news.

### Sources for claims, not reuse permissions

- NASA & NOAA, **November 4, 2026**: https://science.nasa.gov/earth/2026-ozone-hole/
- NOAA, **November 4, 2026**: https://www.noaa.gov/news-release/noaa-nasa-release-measurements-of-2026-ozone-hole
- NASA Earth Observatory: https://science.nasa.gov/earth/earth-observatory/world-of-change/ozone-hole/

Differentiate the **seasonal average 25 million km² (Sep 7–Oct 13)** from the **single-day maximum 27.1 million km² (Sep 18)**. The map source suggested below is **October 4**, not the Sep 18 maximum and must never be captioned as if it were. Explain how a powerful polar vortex raised the 2026 area while the depleted layer was not as deep as historically severe years. Any recovery date is an estimate, not a guarantee.

## Real media candidates: NOT APPROVED YET

See `content/media/p3-18-ozone-pilot-candidate-review.json`. Five individually identified sources are proposed:

1. **NASA SVS 5570**: Earth with atmosphere, NASA SVS/Kel Elkins, first 20s atmospheric video. Source https://svs.gsfc.nasa.gov/5570/
2. **NASA SVS 31365**: The Earth System Science Spheres – horizontal, second 20s atmospheric video. Source https://svs.gsfc.nasa.gov/31365/. **Extra caution:** component datasets have partner/third-party attributions.
3. **NASA SVS 31365**: PACE true color rotating globe, final 20s atmospheric video. PACE image date September 24, **2024**, not 2026. Source https://svs.gsfc.nasa.gov/31365/
4. **NASA Earth Observatory 2026 map**: image dated **October 4, 2026**, real science **foreground** photo. Pinned SHA from pre-existing project reference: `22b83f5dab6248d401e5ac313f98a18626b8c1ca002e43b67209d56f69ce0c6d`. Source page https://science.nasa.gov/earth/earth-observatory/world-of-change/ozone-hole/
5. **NASA GSFC Ozone Watch 2026** local video: the existing private `nasa-ozone-2026.mp4`, SHA `adfd7a539766cb06c71e6bdf3fd87d9c646c0d8e4f11913cb5922cd8a46289bb`, current status **INSPECTED_UNAPPROVED**. Its scientific calendar, colors and legend must remain visible in a fit-to-frame video inset, not as obscured atmospheric wallpaper. https://ozonewatch.gsfc.nasa.gov/SH.html

### Rights/legal evidence boundary

NASA SVS FAQ: https://svs.gsfc.nasa.gov/help/ generally calls visualizations public domain **unless otherwise noted**, but specifically warns of licensed music in some movies. NASA media guidelines: https://www.nasa.gov/nasa-brand-center/images-and-media/ distinguish factual editorial imagery from logos, endorsements, identifiable individuals, and third-party content. **Review the exact five items**, underlying data attribution, embedded marks, audio, third-party rights and actual intended uses. The official produced **2026 Ozone Hole Update** video (NASA SVS 15116) explicitly credits **Universal Production Music**; it is **NOT** one of the five selected files and must not be silently treated as an unrestricted stock background.

The three proposed NASA SVS atmospheric backgrounds also require the
explicit, independently documented manifest fields
`atmosphericVisualReview: true` and
`contentClassification: "ILLUSTRATIVE_BACKGROUND"`. The renderer permits
this very narrow, individually human-reviewed exception for atmospheric
SVS shots; embedded scientific legends or dated datasets should instead
remain protected foreground data, not wallpaper. The original P3-16
science-safe mode is not weakened.

A real approved manifest also requires a corrected, non-placeholder
`captureDate` and a detailed `sourceDateEvidence` explanation of whether
the value means observation, animation dataset date or publication/release.
The draft's intake date is **not** scientific dating evidence.

No metadata rank, NASA origin or generic license page approves a file. The candidate catalog has `rightsApproved: false`, `editorialApproved: false`, and `thirdPartyRightsCleared: false` for **all five**. The rights-reviewed private manifest must record a named reviewer, file-specific evidence, exact checksum, review receipt, source URL, credit and all three explicit true flags, scoped **only** to `P3_18_MANUALLY_APPROVED_EDITORIAL_TEST`. No automatic approval routine exists.

### Manual, isolated asset inspection (not a worker)

After all CI checks on the exact final GitHub commit are complete and green, an authorized operator may *manually* stage the five items in a private directory such as `/home/ap/vns-p3-18-private-candidates` with mode 0700. Do not reuse or modify the original NASA 2026 MP4; make a private copy only if its unchanged exact SHA matches. Download the **four externally linked candidate files** one by one from the exact HTTPS URLs in the catalog using bounded, failed-redirect-safe commands and an independent quarantine directory; do not let background downloads run. If any item fails HTTPS, source verification, declared dimensions/codec, size or pinned hash, stop and inspect.

Use these exact basenames in the private candidate directory:
- `svs-earth-5570.mp4`
- `svs-earth-spheres-31365.mp4`
- `svs-pace-31365.mp4`
- `nasa-ozone-map-2026.jpg`
- `nasa-ozone-video-2026.mp4`

Then run from an exact-SHA-pinned clean disposable worktree:

```bash
node scripts/p3_18_create_media_draft.mjs \
  /home/ap/vns-p3-18-private-candidates \
  /home/ap/vns-p3-18-private-candidates/ozone-pilot-UNAPPROVED.json
```

This reads local files and computes current file SHA-256 values, checks H264 and runtime, confirms pre-existing pinned NASA map/clip checksums and writes a **non-renderable** `INSPECTED_UNAPPROVED` draft with all rights flags false and mode 0600. It **does not** grant permission. The initial `captureDate` is an intake placeholder, not a scientific timestamp; a named reviewer must correct it according to each source record and document the exact observation/release distinction. A scientific inspector must also verify the 2026 Ozone Watch video's actual frame-date coverage. Document review separately.

### Only AFTER individual source approvals

The operator may create a **separate** version of the above manifest after assessing each item's usage rights and editorial accuracy. Required conditions:
- Every candidate individually reviewed; no automatic blanket NASA/Pexels/Pixabay/Unsplash permission;
- All pre-existing manifest gates, including SHA-256, credit, exact real file path, per-file rights reviews and all three true approval booleans;
- Strong file-specific `licenseEvidence` and `reviewReceipt` (not placeholder strings); correct `captureDate`;
- `privateUseScope: "P3_18_MANUALLY_APPROVED_EDITORIAL_TEST"` written only as a result of explicit approval;
- The protected original NASA video is never modified and can be rejected if review is insufficient.

Only then, with the existing pinned Piper model and local Piper executable, the **ap-only** private runner can be invoked:

```bash
VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY \
VNS_P3_18_MEDIA_MANIFEST=/absolute/private/approved-pilot-manifest.json \
VNS_PIPER_PYTHON=/absolute/path/to/piper-python \
VNS_PIPER_MODEL=/absolute/path/to/en_US-lessac-medium.onnx \
node scripts/p3_ozone_minute_private_pilot.mjs --save-private
```

The script checks the exact pinned Piper SHA-256 `5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f`; its commercial reuse rights remain **unknown** and the pilot must be kept private. Speech is synthesized **per editorial beat** into separate clips so the opening words are not lost. Up to 19% gentle tempo adjustment is allowed per beat to fit ten seconds, but **no truncation** is allowed; too-long speech fails instead. Output is a private, unique directory under `/home/ap/videonews-previews`, one 60-second H264/AAC MP4, six contact frames, complete source receipt/hashes, and explicit `publicationAllowed: false`.

The source MP4s are **never modified or deleted**, and the private receipt remains after the temporary worktree is removed. The renderer runs **offline**, no video/voice/download worker or YouTube upload is activated.

## Offline CI proof

```bash
node scripts/p3_ozone_minute_private_pilot.mjs --check-editorial
node --test scripts/p3_ozone_minute_private_pilot.test.mjs
```

The 60-second synthetic CI test creates its **own synthetic** videos and image. It checks source/rights refusal, evidence fields, centered layouts, three background sources with two real 12-frame transitions, two foreground scientific media slots, exact 1440 frames, one video-only export, and separate H264/AAC mux with original source audio absent. CI never downloads the five real candidates and never creates the real NASA/Piper film. Passing CI does not clear actual NASA or Piper rights.

## Human visual acceptance

Check especially that the new content is **not corner-stacked**, the 25m and 27.1m metrics are readable centrally, the background evolves across beats 1–2, 3–4 and 5–6 with smooth cuts, the 2026 scientific images preserve their calendar and scales, narration onset is clean, and the final MP4 is 60s exactly. The private result must be manually assessed before any merge decision. PRs #540 and #542 remain stacked dependencies; do not merge this branch into main ahead of them.
