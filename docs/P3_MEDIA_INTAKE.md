# P3-08 offline media intake: images and moving footage

This is a **preflight**, not a downloader or a rights-granting system. Keep the
existing script's 19 graphics, review-only watermark and publication gates.

The local manifest is operator-authored JSON (schemaVersion=1, assetRoot as
an absolute private directory, assets as an array). Each asset requires:

- `id`, `sceneId` and stable `motifId` shared across crops, recolors,
  resized copies, stills extracted from the same shot, and alternative encodes;
- `kind` = `photo` or `video`, absolute local `path`, lower-case SHA-256;
- `sourceUrl`, `creator`, `credit`, `captureDate` (YYYY-MM-DD);
- `licenseUrl`, `licenseEvidence` (the actual evidence of allowed usage),
  `rightsReviewedBy`, `rightsReviewedAt` (YYYY-MM-DD);
- explicit `rightsApproved: true`, `editorialApproved: true`, and
  `thirdPartyRightsCleared: true` after real human review.

No fields are inferred from a provider's homepage or a search snippet.
`node scripts/check_episode_media_manifest.mjs /private/path/manifest.json`
verifies hashes, the asset root, approved status, and uniqueness of SHA,
file path, scene ID and motif ID. Fails closed when any of these are missing.

### Optional private preview footage (experimental)

The separate `scripts/p3_private_clip_support.mjs` module now connects a
reviewed **local H.264 MP4** to a single still-graphic beat in the private P3
renderer. Only the explicit `--save-local` operator path may set
`VNS_PRIVATE_MEDIA_MANIFEST=/absolute/private/manifest.json`. Omit the
variable to keep the existing six NASA stills + 13 original graphics.

`sceneId` names a 1-based scene as `beat-02`, `beat-04`, etc. A clip
cannot replace any of the six reserved photo-backed scenes. Clips cannot
repeat, loop, freeze their last frame, or carry their source audio into the
narration. Each must be at least 640x360 and at least 0.1 seconds longer
than the final audio-aligned beat duration; the measured timeline, not a
hardcoded estimate, decides the required length. The renderer scales/crops
to 1280x720 at 24fps and adds a new light lower-third, the capture date,
source credit and an explicit **PRIVATE PREVIEW - NOT FOR PUBLICATION**
watermark. It never downloads or publishes footage.

Example **structural** setup, after independently reviewing real license
evidence and obtaining appropriate footage on the VPS:

```bash
VNS_PRIVATE_MEDIA_MANIFEST=/home/ap/private-media/episode-manifest.json \\
  VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY \\
  VNS_PIPER_PYTHON=/home/ap/.local/share/vns-piper-venv/bin/python \\
  VNS_PIPER_MODEL=/home/ap/.local/share/vns-piper-voices/en_US-lessac-medium.onnx \\
  VNS_VISUAL_ASSETS_DIR=/home/ap/.local/share/vns-visual-assets \\
  node scripts/vps_p3_full_english_piper_preview.mjs --save-local
```

No manifest or clip is currently supplied or approved for this example.
The CI codec test creates its **own synthetic motion fixture**, does not
download outside footage, checks 48 output frames and verifies that the
fixture audio track is discarded. CI still cannot create a full private MP4.

In particular:
- SHA-256 detects byte-identical files, and motif IDs document human review;
  automated perceptual near-duplicate video-frame analysis is **not yet done**.
- A valid manifest is **not** evidence that a clip is legally usable:
  reviewers must inspect the real license, the item and third-party content.
- No video is auto-downloaded or uploaded. An explicitly reviewed local video can be inserted only into the private manual preview.
- The Piper Lessac demo and all episode publication rights remain BLOCKED.
- Only private preview media should be placed in the local non-webroot cache.
