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
