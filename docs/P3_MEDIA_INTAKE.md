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

The checker is not connected to rendering yet. In particular:
- SHA-256 detects byte-identical files, and motif IDs document human review;
  automated perceptual near-duplicate video-frame analysis is **not yet done**.
- A valid manifest is **not** evidence that a clip is legally usable:
  reviewers must inspect the real license, the item and third-party content.
- No video is auto-downloaded, uploaded or added to the episode.
- The Piper Lessac demo and all publication rights remain BLOCKED.
- Only private preview media should be placed in the local non-webroot cache.
