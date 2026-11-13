# P3-16 — Science-safe cinematic footage (private, review-only)

Issue: #539. This change builds on merged P3-08 through P3-15. It does **not**
approve a source or any rights and does not call a media provider, live worker
or publication endpoint.

## Why the layout is necessary

The default P3-09 cinematic layout contains a semi-transparent caption at
y=454..679 and a persistent provenance strip at y=0..64. Both can cover
labels embedded in scientific footage. In an Ozone Watch animation, frame
labels, calendar dates, legends and color scales are **scientific content**, not
decorative background. Merely making the bottom bar translucent is not
sufficient.

## How to opt into the protected compositor

For a *separately human-reviewed* H264 MP4 already validated by the existing
episode manifest, set **both** of the following on its existing asset entry:

```json
{
  "scientificVisualization": true,
  "compositionMode": "science-safe"
}
```

Retain all required fields: real source URL, exact SHA-256, creator, credit,
captureDate, rightsReviewedBy/At, license URL/evidence and the existing
`rightsApproved`, `editorialApproved` and `thirdPartyRightsCleared` gates.
The two flags above **never grant approval**. Missing or false rights gates
continue to be refused by `validateEpisodeMediaManifest` before rendering.

`ozonewatch.gsfc.nasa.gov` and `svs.gsfc.nasa.gov` are also classified as
science-safe sources by URL, so setting `compositionMode: "standard"` or
omitting the mode is rejected for those hosts. Other scientific-footage
providers must be explicitly marked `scientificVisualization: true`.
Unknown composition modes and non-boolean `scientificVisualization` values
fail closed. Normal, nonscientific video retains its earlier cinematic
lower-third behavior. The offline NASA Ozone Watch/SVS source scout now places
both science-safe flags in its *unapproved* manifest draft by default; this
must never be mistaken for source-specific rights clearance.

The protected video is scaled to **fit, never crop** inside the 960×540
viewport x=320..1279, y=90..629 of the 1280×720 output. Aspect ratio is
preserved and padded within that viewport if necessary. Captions, compact
charts and the persistent private-preview/citation banner are clipped to
the **separate left 320-pixel rail** and cannot cover any source pixel.
The source image may be reduced, so **readability still requires human
review**; this is a structural no-overpaint guarantee, not an optical
legibility certification. Tiny embedded numbers may require an alternate
asset or bespoke editorial composition.

For a three-beat continuous shot, the moving video is kept as one continuous
background and each sidebar caption fades separately on exact 24fps beat
boundaries. Source audio is discarded. The existing short-insert plus graphic
tail rules, checksum validation, time budget, and no-loop limits remain intact.
Default cinematic clips still use the original P3-09 presentation.

## Isolated offline CI proof

Run in a sandbox with FFmpeg, ffprobe and librsvg2-bin installed:

```bash
node --test scripts/p3_science_safe_composition.test.mjs
node --test scripts/p3_cinematic_timeline.test.mjs
node --test scripts/p3_cinematic_short_insert.test.mjs
node --test scripts/p3_integrated_private_preview.test.mjs
```

The new test constructs **five seconds of original synthetic moving video**
with four colored corner markers standing in for scientific annotations and
an unwanted source audio track. After rendering, it checks all four
corners in the output, 96 frames, video-only H264 export, independent sidebar
SVGs, invalid mode refusal, unapproved-source refusal and protected-host
refusal. It does **not** download or access the NASA file or use live stock
footage. A passing CI test does not certify perceptual film quality.

## P3-16 visual quality review witness (synthetic, no NASA)

The synthetic pixel tests prove non-overpaint but do not leave a video that
the operator can watch. The new `scripts/p3_science_safe_visual_review.mjs`
constructs **two original synthetic moving motifs** with date, corner labels,
and a five-color legend burned *inside* each source frame. It then uses the
existing reviewed-manifest and cinematic renderer to export five independent
overlay beats (15–19), 240 frames / 10 seconds at 24 fps, and one independent
440 Hz **synthetic** narration stand-in. The two synthetic sources contain
different embedded tones: the final audio always maps only the independent
soundtrack, never a source track. The script also captures the center frame
of every beat at seconds 1, 3, 5, 7 and 9.

CI exclusively runs `--verify-ephemeral`, which validates the H264/AAC export,
all five JPEG contacts, 240 frames and source asset SHA-256 values before
removing the entire temporary workspace. It deliberately does *not* use
actual NASA footage or a Piper model.

For an explicitly authorized, **ap-only** operator session on the VPS, run
`VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY node
scripts/p3_science_safe_visual_review.mjs --save-private` from an exact
SHA-pinned clean Git worktree, **after all last-commit GitHub Actions finish
green**. This uses only synthesized assets and writes only into the existing
private preview parent, under the newly created folder
`/home/ap/videonews-previews/p3-16-science-safe-visual-review/`.
It refuses to replace an existing review folder; the folder must be
owned by `ap` and private (mode 0700). Retained files include:

- `science-safe-visual-review.mp4`: video and single test audio;
- `review-frame-01.jpg` through `review-frame-05.jpg`: one per beat;
- `review-receipt.json`: output/source/contact SHA-256, simulated status,
  frame count and explicitly `publicationAllowed: false`.

The temporary generation workspace is removed regardless of exit status.
The saved preview and receipt are NOT part of the temporary workspace and
are deliberately retained for manual review. Do not automatically delete
those retained files. The synthetic success flag is **not human visual
approval** and is not evidence for clearing rights on actual NASA assets.

Inspect the contact pictures and private MP4 manually, especially the
source's four corners, side rail, motion and fades. Record the assessment
separately. The full English 19-scene Piper episode still needs its own
private end-to-end viewing and rights-gated real-footage review.

## Real footage remains blocked

The VPS asset
`/home/ap/.local/share/vns-visual-assets/nasa-ozone-2026.mp4`
with SHA-256
`adfd7a539766cb06c71e6bdf3fd87d9c646c0d8e4f11913cb5922cd8a46289bb`
remains **INSPECTED_UNAPPROVED**. It must not be placed into a render-approved
manifest until its actual time coverage, source-specific reuse conditions,
third-party elements and editorial accuracy are documented and reviewed.
Likewise the Piper model's commercial rights remain a separate question.
Do not copy the synthetic test fixture's approval flags to real media.

After all checks for the **last PR commit** are green, an operator may
run the synthetic test in a disposable worktree. Only after separate rights
evidence and human approval can the existing strictly private 19-scene
Piper preview receive an explicitly approved cinematic manifest. The
`VNS_CINEMATIC_MEDIA_MANIFEST` and `VNS_PRIVATE_MEDIA_MANIFEST` modes
must not be enabled together. Never enable news/download workers or upload
the result as part of this acceptance step.

A human review of a real private export should record: source-frame
legibility at 1/7/14 seconds (or source-relevant times), scene changes,
transition quality, independent overlay fades, introduction audio integrity,
credit accuracy, end-of-film synchronization and export SHA. Retain the
rights/evidence receipt even if the separate temporary episode-media
workspace is later cleaned after a verified export.
