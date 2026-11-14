# P3-18 – Authentic one-minute English ozone editorial pilot (private only)

Issue: #543. This branch is stacked on P3-17 PR #542, which depends on P3-16 PR #540. It **must not be merged independently** or deployed to productive workers.

## Editorial aim and layout

Respond to operator feedback that P3-17 information was too close to the four corners. Use cinematic FULL-SCREEN B-roll for the background, a partially transparent navy/teal overlay above it, then highly visible, independent **centrally placed** editorial graphics. Six ten-second beats / 1440 frames / 60 seconds at 1280×720, 24fps:

| 0–10s | Centered opener | "Antarctica's Ozone Hole" | Earth backdrop A |
| 10–20s | Large center metric | 25 million km² seasonal average | Same backdrop A |
| 20–30s | Large center metric | 27.1 million km² single-day maximum | Crossfade to backdrop B |
| 30–40s | **Large, undimmed 2026 Ozone Watch animation** (date bar intact) | Antarctic ozone changes through winter | Backdrop B remains concealed |
| 40–50s | **Large, undimmed October 4 Earth Observatory Dobson map** | Source's original 100–500 DU scale | Backdrop B continues behind map |
| 50–60s | Spacious closing, centered typography | Montreal Protocol / recovery, no third tiny corner-card | Crossfade to backdrop C |

Crossfades consume 12 input frames (0.5s) per boundary, with six extra source frames from each neighbor, so narration length is unchanged. Every background is independently SHA-verified, H264 and at least 20.25/20.5 seconds. No source audio passes through. Science photo/video is fit into a **1088×612** almost-full-frame stage at (96,82), never cropped, never dimmed by the atmospheric overlay. Its original source calendar, time bar and Dobson-unit scale stay within the source viewport. Header and source-specific key are positioned OUTSIDE that viewport. This is the actual requested background/gradient/foreground video style, not the P3-16 rigid side rail.

English script and per-scene sources are in:
`content/news/ozone-2026-minute-editorial-pilot-en.json`.
The revised editorial narrative is original (126 English words). It is an editorial **private review**, not published news.

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

### V2 operator-contact visual redesign: science first, no corner dashboard

On the operator's 13 verified original NASA contact frames, the 2026
Ozone Watch animation shows **July 7, August 18 and September 29, 2026**
with a source-embedded date bar. The October 4 NASA Earth Observatory
map shows a **100–500 Dobson-unit** color scale on a light source panel.

**CRITICAL:** the Earth Observatory map uses **RED/ORANGE for low ozone**
while the NASA Ozone Watch video has visually different **blue/purple**
Antarctic colors. The Ozone Watch frame samples here do NOT include the
same Dobson legend. Never assign one shared palette, infer exact quantities
from the animation colors, recolor scientific source pixels, or assert the
map is the September 18 maximum. Each piece has a truthful, separate
source-specific text label and intact **original** scientific graphics.

The renderer's P3-18-specific `science-stage` now places each scientific
source at (96,82), 1088×612, approximately 82% of the entire 1280×720
frame. Header (y=61) and source/date note (y=714) live *outside* the
scientific source content. Sources remain the dominant center visual.
Non-science scenes still use gradient-dimmed moving Earth B-roll and
centered, large stats. The 3 Earth-background sources are **not**
presented as three equally important consecutive shots: the two science
scenes conceal nearly all of their background. The background spans
are beat-01..02 (A), beat-03..05 (B), and beat-06 (C), preventing a
duplicate scene start between the original map at beat-05 and its
background. This preserves existing scene-ID uniqueness checks and
reduces an unnecessary third Earth crossfade behind the map. Original P3-16/17 modes
are unchanged.

The 2026 Ozone Watch source lasts about 15 seconds, but the voice-edited
beat is currently 10 seconds. The real film at ordinary playback speed
will show only the **first 10 seconds** (not necessarily the September 29
source frame). The static **storyboard** can deliberately select the
September 29 contact as a *representative scientific illustration*; it
must NOT be represented as a precisely time-aligned frame from the
eventual 60-second film. Any future playback-speed adjustment would need
its own explicit editorial decision, scientific correctness check and
new end-to-end tests.

**Existing intake manifest warning:** the original
`ozone-pilot-UNAPPROVED.json` and source-audit receipt were created
before this scene swap, so their scene IDs still refer to the earlier
draft order. **Do not promote or use them as render-ready manifests.**
They remain unchanged evidence. The future separately reviewed
real-film manifest must match the V2 candidate catalog:
`nasa-ozone-video-2026` = beat-04 and
`nasa-ozone-map-2026` = beat-05.

### Private six-frame real NASA contact storyboard (not a film)

`scripts/p3_18_centered_storyboard.mjs --save-private` is an
independent **ap-only offline, explicit opt-in** source-image study.
It reads the existing, fully SHA-pinned
`p3-18-real-source-audit/source-audit-receipt.json`, checks all five
unchanged original NASA SHA values, checks all 13 already-audited
contact JPEG SHA values and the original explicitly unapproved
media intake manifest. It never edits the original media or receipt.

It then builds **six static PNG layouts** (one per beat) using
only the existing contact JPEGs, then creates a single
**2×3 comparison sheet**. Beat 4 prominently stages an Ozone Watch
sample; beat 5 the independent Earth Observatory map. Every image is
stamped **"UNAPPROVED · PRIVATE STORYBOARD"**. A private SHA receipt
records source contact names and scene-by-scene PNG checksums. There
is no real NASA moving movie export, no Piper audio, no rights approval
and no upload.

The contact chosen for beat 4 is a visual reference, not an exact frame
of the 10-second science-animation segment. Original native-resolution
files need separate review to judge small source labels.

After all exact-head GitHub Actions succeed, run in an isolated pinned
worktree from the existing `ap` account:

```bash
VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY \
  node scripts/p3_18_centered_storyboard.mjs --save-private
```

New private output only (refuses if already present):
`/home/ap/videonews-previews/p3-18-centered-storyboard-v2/`
with `storyboard-beat-01.png` through
`storyboard-beat-06.png`,
`p3-18-centered-visual-storyboard.jpg`, and
`storyboard-receipt.json`. The output and original evidence
are never published or promoted to rights-cleared status.

CI tests use fully original **synthetic** stills, test large
science-stage geometry, source-specific palette notes, preserved
bright science/source colors over a darkened background, and the
frame plan. No real NASA data or files are imported by CI.

## Source-specific offline contact audit (P3-18 follow-up)

The five files were downloaded by the operator and an explicitly
**UNAPPROVED** manifest was produced on the VPS. Do not replace this intake
manifest or automatically flip any rights flags.

The new **non-rendering** auditor
`scripts/p3_18_audit_real_media.mjs --inspect-private`
runs only with the explicit `ap` private review opt-in, reads:
`/home/ap/vns-p3-18-private-candidates/ozone-pilot-UNAPPROVED.json`
and the five original media files, re-verifies SHA-256, H.264, dimensions,
audio presence and duration, and produces **read-only review derivatives** in
`/home/ap/videonews-previews/p3-18-real-source-audit/`.

- Three JPEG contact frames per moving source: seconds 1, 10 and 20 for
  each of the three atmospheric backgrounds; seconds 1, 7 and 14 for the
  real NASA Ozone Watch 2026 clip.
- One fitted JPEG preview of the 2026-10-04 ozone-map still.
- `source-audit-receipt.json` preserves the hashes and technical stream
  facts along with NASA source URLs, known release dates, dataset warnings,
  attribution notes and **unanswered** human checks per source.
- Total **13 contact JPEGs**, each with SHA-256. Review images are downscaled
  to 960×540 only for inspection. For tiny calendar text, legend ticks, and
  scientific labels the **original full-resolution files must still be
  examined**. No OCR or AI-inferred rights decisions are used.

The reviewer should pay special attention to NASA SVS 31365: its composite
Spheres movie switches datasets every ~27 seconds. It is not a 2026 ozone
measurement and its exact 0–20 s excerpt must be assessed, with credits
for PACE/SWOT/GRACE-FO data and contributors as applicable. PACE true
color is based on **2024-09-24** imagery. NASA SVS 5570 was released on
**2025-07-21** and credits Kel Elkins, William Putman and Reto Stockli's
Blue Marble data. Source pages:

- https://svs.gsfc.nasa.gov/5570/
- https://svs.gsfc.nasa.gov/31365/
- https://ozonewatch.gsfc.nasa.gov/SH.html
- https://svs.gsfc.nasa.gov/help/
- https://www.nasa.gov/nasa-brand-center/images-and-media/

The auditor **refuses** existing output directories and files changed since
intake, never edits originals, never connects to media providers or downloads
additional material, never renders a composed film, and never sets
`rightsApproved`, `editorialApproved` or
`thirdPartyRightsCleared` to true. Output contains only source/rights
**questions**, not clearance. No automated promotion of an unapproved source
manifest is provided. Original source attribution, precise scientific
timestamps and third-party/music rights remain subject to human review.

Offline synthetic regression:
`node --test scripts/p3_18_audit_real_media.test.mjs`.

**Still-image (NASA October 4 map) compatibility fix:** Input seeking
(`-ss 0`) on a single JPEG can make some FFmpeg versions exit with
status zero yet create no review image. The auditor now handles a
`photo` input separately, using the image2 demuxer's `-loop 1`
and `-framerate 1`, extracting **exactly one** contact JPEG
(`-frames:v 1`). Video sources continue to use their exact sampling
timestamps and do **not** loop. A dedicated regression test creates a
real single-frame JPEG and asserts that the contact exists and retains
960x540 dimensions while the original input SHA-256 remains unchanged.

The original failed VPS run raised `ENOENT` for
`nasa-ozone-map-2026-frame-01.jpg`. Because the script owns the
newly-created private audit directory and catches this failure,
it removes **only that incomplete private audit-output directory**.
The five quarantined NASA sources and their unapproved manifest are
never deleted or modified. Before retrying, verify that the output
directory does not already exist; if it does, inspect it manually rather
than deleting evidence automatically.

After all workflows for **this exact last commit** are green, run in an
SHA-pinned disposable git worktree:

```bash
VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY \
  node scripts/p3_18_audit_real_media.mjs --inspect-private
```

No file outside the dedicated private audit-output directory is created or
modified; the audit source files and intake manifest remain intact. The audit
output deliberately persists for human viewing, and no cleanup of these
proofs should occur without operator review.

## Only AFTER individual source approvals

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
