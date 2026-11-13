# Full private 8–10 minute Earth & Climate Explained episode (P3-07)

**Operator objective:** Watch one complete English episode using the original
2026-11-09 script plan in `docs/EXPLAINED_SCRIPT_STRUCTURE_V1.md`, with the
calmer Piper narration, NASA backgrounds, dark text overlay and 19 P3 original
graphics. Do **not** change the seven-part editorial story format.

## Editorial source of truth

`content/news/ozone-2026-explained-en.json`: English, exactly 1,264 spoken
words, 19 visual beats, and six cited sources, manually curated as of
2026-11-09 (NOAA/NASA joint seasonal analysis, Copernicus, DLR, EPA, UNEP).
No current/live story ingestion. Published-at dates and source relationships
must not be silently rewritten, merged or presented as independent if they
refer to the same underlying analysis.

Canonical sequence from the written plan:

1. `hook`: The Hook
2. `basics`: The Basics
3. `what-happened`: What Happened?
4. `why-is-it-happening`: Why Is It Happening?
5. `why-it-matters`: Why It Matters
6. `whats-next`: What's Next?
7. `takeaway`: The Takeaway

The seven-chapter validator checks sequence/format; voice audio is synthesized
**first** and actual durations drive the 24-fps 19-beat scene timeline. No
hardcoded chapter length or stretching the video with silence.

## Preview quality

- Offline Piper English voice `en_US-lessac-medium` (exact SHA as in the
  shorter test) at `--length-scale 1.04`, `--sentence-silence 0.38`.
- Two SHA-pinned NASA stills already installed by the operator:
  `earth-nasa.jpg` (NASA Earth imagery) and `ozone-2026-nasa.jpg`
  (NASA Earth Observatory ozone data visualization, October 2026). Foregrounds
  use an opaque-safe dark overlay to preserve typography legibility; captions
  include NASA credit and inset ozone maps where the text layout permits.
  Refer to `docs/P3_NEURAL_MOTION_QUALITY_TEASER.md` for URLs and credits.
- All 19 original P3 SVG graphics remain private watermarked previews. Titles
  and source metadata remain pixel-still; a thin accent line animates
  independently at each visual-beat entrance. This remains an explainer
  prototype, not professionally sourced dynamic footage.
- H264/AAC output at 1280x720, 24 fps, strict measured duration 480–600 s.
- Each of the 19 scenes is now encoded **sequentially** in a bounded, single-threaded FFmpeg invocation; the identical H264 tracks are concatenated with stream-copy and the continuous narration is AAC-encoded once. This avoids one long, high-memory FFmpeg filter graph.
- FFmpeg subprocess failures report exit status, signal, and error code, not just `null`. A vanished FFmpeg process can indicate a host resource limit; do not infer OOM without checking the kernel/host logs.
- CI renders **only a disposable 3-second two-scene MP4** to verify encode, stream-copy stitch, AAC mux, duration and codec handling; it creates no full episode video.
- The full MP4 is **created only by the operator on the VPS** and stored in
  `/home/ap/videonews-previews/`, not in the application webroot.
  CI checks all seven real voice WAVs, all 19 NASA-composited frames
  and a disposable 3-second encoding smoke test, but **never encodes or retains a full MP4**.

## VPS operator command (after merge)

With `npm` dependencies installed and `@vns/shared` built:

```bash
CI=false GITHUB_ACTIONS=false \
VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY \
VNS_PIPER_PYTHON=/home/ap/.local/share/vns-piper-venv/bin/python \
VNS_PIPER_MODEL=/home/ap/.local/share/vns-piper-voices/en_US-lessac-medium.onnx \
VNS_VISUAL_ASSETS_DIR=/home/ap/.local/share/vns-visual-assets \
  node scripts/vps_p3_full_english_piper_preview.mjs --save-local
```

This is not an automatic app feature, not an Admin download endpoint, and
not a release. The script never calls paid APIs, Redis, a worker, YouTube
or any publishing integration. All editorial/rights/render/upload/publication
flags remain **false**.

**Voice licensing:** The currently tested Lessac training-corpus permissions
are not cleared for monetized distribution. Treat this output only as a
private prototype. Select a voice with suitable rights before publication.
Server and GitHub Actions over-quota charges, if any, are separate from the
free local tools.

## Audience review: diversified visuals and clean opening

The first complete private rendering succeeded (505.083 s) but the operator
noticed a sound defect during approximately the first three seconds and
repetition of two images during all 19 graphic beats. The original MP4 was
not available to inspect, so the exact **cause of the audible defect is not
confirmed**.

For the next version the first entire sentence is synthesized as a separate
Piper utterance, while the rest of the Hook is synthesized separately. Both
outputs are joined without dropping words, with a 180-ms silent onset and a
120-ms gentle fade-in. The format and factual script are unchanged.
**Operator playback of the opening is still needed** to confirm the audible
fault is actually resolved; this is not an automatic speech-quality proof.

Images are now selected by 19-beat editorial mapping rather than alternating
`index % 2`, for **six distinct NASA-sourced background images**. Both
existing files are retained:

- `earth-nasa.jpg`: PIA18033, Suomi-NPP Earth, NASA (2012).
- `ozone-2026-nasa.jpg`: NASA Earth Observatory ozone data map, Oct 4, 2026
  (NASA Earth Observatory / Lauren Dauphin).

Four new NASA Photojournal files are manually downloaded *once* by the
operator into the same private `VNS_VISUAL_ASSETS_DIR`:

| Local file | NASA source / description | Original capture or data | Required SHA-256 |
| --- | --- | --- | --- |
| `PIA00117.jpg` | https://science.nasa.gov/photojournal/earth-ross-ice-shelf-antarctica/ — NASA/JPL Ross Ice Shelf | Dec 8, 1990 | `18cced99e3516bf3720b7bb9040724cabcaf2fc1fe97da7754df69a0b303e70e` |
| `PIA00728.jpg` | https://science.nasa.gov/photojournal/global-images-of-earth/ — NASA/JPL Galileo Earth montage | Archival Galileo imagery (1990s) | `53119b3ef93d47bb842cfa4e2df2e0253adc9f24b1836755b5ffab041023f50f` |
| `PIA20664.jpg` | https://science.nasa.gov/photojournal/ozone-hole-formation-over-south-pole-observed-by-nasas-airs/ — NASA/JPL-Caltech AIRS vortex visualization | 2014 data | `58aff245ac9f2b6c0c5af05829c6c21b03c59382cc44e9e092157cc76749b9e4` |
| `PIA00116.jpg` | https://science.nasa.gov/photojournal/earth-antarctica-mosaic/ — NASA/JPL Antarctica / atmospheric limb mosaic | Dec 8, 1990 | `5a2fa81a95ec1bd03119fcc7ead8c162e061311705d964d92712fe0cc02166ab` |

Exact direct-file URLs follow NASA's own Photojournal image format:
`https://images-assets.nasa.gov/image/PIA00117/PIA00117~orig.jpg`, etc.
They are fixed by SHA-256 and are not hotlinked at render time. The archival
visuals and 2014 ozone-data image are **explicitly credited and dated in-frame**
so they cannot be confused with observations taken in 2026. These are
educational illustrations, not verification of contemporary measurements.
NASA's media rules (including separate third-party-media and
non-endorsement constraints) still apply:
https://www.nasa.gov/nasa-brand-center/images-and-media/

The same 19 original SVG foregrounds stay pixel-still. Graphic animation
remains limited to isolated decorative elements, rather than moving type.
The full 8–10-minute MP4 is only rendered manually on the VPS. The CI audio,
six-image compositing and disposable 3-second mux smoke check do **not**
establish subjective listening quality or YouTube publication clearance.


## Visual uniqueness gate (follow-up prototype)

The private preview renderer now enforces **one source image per episode**.
Of the 19 visual beats, only six use the previously SHA-pinned NASA photos,
each exactly once; 13 are original SVG graphics with no repeated
photographic background. Cropping, zooming, recoloring or renaming a source
file is **not** a new motif. An explicit duplicate SHA-256 manifest check
prevents byte-identical files from masquerading as distinct assets.
The programmatic scene map also rejects repeat assignments. These are
source-level checks; near-duplicate *perceptual* detection is future work.

All picture-in-picture inserts have been removed. The original graphic's
full background is retained for graphic-only beats. The dark photograph
overlay is slightly less opaque. The project does not yet have a verified
license-safe moving-video asset pipeline; **do not silently scrape videos**
or treat unspecified third-party clips as approved.

Next video-source integration requirements:
- Manually reviewed source URL, credited creator, capture/data date,
  precise license/rights statement, permitted use, and pinned digest;
  video frame comparisons must catch reused video/motifs.
- Distinguish actual footage from simulation and historical archive; no
  archival climate footage should suggest it was recorded in 2026.
- Local deterministic cache only, conservative ffprobe validation, no
  download during rendering, fail closed for unknown rights.
- Maintain explicit human editorial, rights, upload and publication gates
  (all remain DENIED); the Piper Lessac voice is for private demo only.
- Run the CI smoke test and review the full private VPS output before
  describing motion or picture quality as validated.

The earlier sections describe the previous six-background version and
are preserved for historical comparison. This section supersedes prior
references to recurring photo backgrounds and picture-in-picture insets.
