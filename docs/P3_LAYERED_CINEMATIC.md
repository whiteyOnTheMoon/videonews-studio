# P3-17 – Full-bleed layered cinematic newsroom composition

Depends on [P3-16 PR #540](https://github.com/whiteyOnTheMoon/videonews-studio/pull/540) and issue #541. P3-16's independent, protected science-safe rail is **retained as a separate option**; P3-17 implements the requested full-screen moving background behind a transparent navy/teal gradient and **independently animated foreground information**.

## Visual architecture

1. **Background video** fills 1280×720 at 24 fps. Background footage is atmospheric: it is allowed to be dimmed, cropped and partially obscured by text, graphics, and science cards. Original audio is discarded.
2. **Gradient layer** is a transparent navy/teal SVG covering the canvas: stronger darkness to the left for the headline, lighter to the right to reveal the moving imagery, subtle lower vignette.
3. **Foreground video/image cards** may overlay the moving background. Scientific videos are scaled to **fit without cropping** within a separate 448×252 inset at x=765, y=242; captions/credits live outside its pixel area. Optional reviewed photos use the same panel placement.
4. **Beat overlays** are different SVG compositions with animated alpha fade and persistent source labels. They do not interrupt or restart the background video.
5. **Private watermark** is independent and is always visible in the private test/export.

The 12-frame crossfade at 24fps lasts 0.5 seconds. Each adjoining video supplies an additional six frames around the original beat boundary. The xfade overlaps those frames, ensuring the total output remains **exactly the sum of narration frames** without duplicated/stretched/frozen video or a shortened narration. Every source must be long enough for its allocated beats **plus** the crossfade handles and 0.1 seconds.

## Explicit manifest – no automatic approvals

The existing media manifest schema version stays 1; new P3-17 fields per asset are:
- \`role\`: \`background\`, \`science-inset\`, or \`image-card\`.
- \`compositionMode\`: exactly \`layered-cinematic\`.
- \`sceneId\` and \`endSceneId\`: inclusive consecutive beat range (01..19).
- \`scientificVisualization: true\` for genuine scientific foreground video.

All existing fields remain mandatory: absolute file path under private asset root, source URL, license URL/evidence, creator, credit, capture date, SHA-256, rights-review reviewer/date, and **true** \`rightsApproved\`, \`editorialApproved\`, \`thirdPartyRightsCleared\`. The P3-16 **unapproved NASA scout manifest must never be relabeled as approved** to satisfy this requirement.

Schematic manifest entry *not usable by itself*:

\`\`\`json
{
  "schemaVersion": 1,
  "assetRoot": "/absolute/private/approved-media",
  "assets": [
    {
      "id": "reviewed-atmospheric-shot-01",
      "motifId": "distinct-source-shot-01",
      "kind": "video",
      "role": "background",
      "compositionMode": "layered-cinematic",
      "sceneId": "beat-01",
      "endSceneId": "beat-04",
      "path": "/absolute/private/approved-media/clip-01.mp4",
      "sha256": "<exact verified 64-hex SHA>",
      "sourceUrl": "https://source.example/path",
      "creator": "<real creator>",
      "credit": "<real credit>",
      "licenseUrl": "https://source.example/rights",
      "licenseEvidence": "<source-specific review evidence>",
      "rightsReviewedBy": "<reviewer>",
      "rightsReviewedAt": "2026-11-13",
      "captureDate": "2026-11-13",
      "rightsApproved": false,
      "editorialApproved": false,
      "thirdPartyRightsCleared": false
    }
  ]
}
\`\`\`

**Warning:** the example is intentionally unapproved and incomplete for a full episode (the other beats have no backgrounds). An actual layered render must supply enough **independently reviewed** nonoverlapping background ranges to cover all narrated beats. Foreground assets can be placed over those backgrounds but their starting scene IDs must be unique in the existing manifest. Foreground insets must not overlap one another. Clips must be unique SHA-pinned H264 MP4 (no looping); optional photos JPG/PNG remain individually reviewed. Scientific footage from the NASA Ozone Watch/SVS hosts and sources flagged \`scientificVisualization: true\` cannot be placed as obfuscated background: use an inset if precise labels/legends matter.

## Private full English episode opt-in

In an authorized \`ap\`-only \`--save-local\` invocation of the existing full-English script, use:

\`\`\`bash
VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY \
VNS_LAYERED_MEDIA_MANIFEST=/absolute/private/reviewed-layered.json \
node scripts/vps_p3_full_english_piper_preview.mjs --save-local
\`\`\`

This is an **interface description, not authorization to run**. The runner still requires the previously pinned Piper model, NASA image files, voice configuration, protected private directory, 1GiB disk preflight, source-level rights approvals, actual narration timestamps and export controls. Do **not** use it with \`VNS_CINEMATIC_MEDIA_MANIFEST\` or \`VNS_PRIVATE_MEDIA_MANIFEST\`. On the VPS, an operator must approve each real asset and its specific reuse conditions *first*. Normal CI is explicitly forbidden from saving an episode. A single full-length multi-source FFmpeg graph can be CPU/memory intensive; measure resources in an isolated disposable test before using it for a complete 8–10 minute film.

## Synthetic preview and CI acceptance

\`\`\`bash
node --test scripts/p3_layered_cinematic_composition.test.mjs
node scripts/p3_layered_visual_review.mjs --verify-ephemeral
\`\`\`

The test constructs two synthetic, distinctly colored video sources with unwanted audio, one synthetic scientific video inset with audio, and one synthetic photo card. It checks explicit rights and SHA rejection, span coverage, 12-frame xfade sample pixels, exact 240-frame 10-second output, and correct H264/AAC mux with source audio omitted. The second script creates a more illustrative **10-second five-beat** film using three entirely generated local assets, then extracts five JPEG contact frames with a SHA-256 provenance receipt. CI only runs ephemeral mode, removing all generated files.

**After every GitHub Actions workflow is completed/success for the exact last commit**, an operator can use \`--save-private\` instead, with \`VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY\`, a clean SHA-pinned disposable worktree, local user \`ap\` and **no CI context**. This saves to the new dedicated private directory:

\`/home/ap/videonews-previews/p3-17-layered-visual-review/\`

Expected: \`layered-visual-review.mp4\`, five \`review-frame-0N.jpg\` contact frames and \`review-receipt.json\`. The script refuses overwriting an existing directory, validates file hashes, and keeps publication and human-approval flags false. Do not automatically remove evidence.

## Outstanding gates

- P3-16 is a draft dependency and must be accepted/merged in order first.
- CI and VPS synthetic media tests cannot certify real visual quality, legibility or rights.
- No NASA video, stock footage or voice is pre-approved. The NASA 2026 ozone MP4 is still \`INSPECTED_UNAPPROVED\`; the Piper model remains a separate licensing decision.
- No provider/download/news workers are enabled, no files are published, no YouTube upload is performed.
- Human review of the resulting **new 10-second layered private MP4** must check background continuity, gradient transparency, crossfade, readable titles and science inset before recommending merge or any full real footage episode.
