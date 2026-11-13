# P3-09 – Cinematic timeline (private experiment)

## Goal
Move away from a new full-screen PowerPoint-style still for every spoken
visual beat. The **three independent tracks** are:
- **Background:** one H264 video shot covering one to three consecutive
  visual beats as a *single continuous use* of the same motif.
- **Overlay:** independently timed semi-transparent captions, headlines and
  compact data bars; they fade in/out without resetting the background.
  Persistent source credit and **PRIVATE PREVIEW – NOT FOR PUBLICATION** text
  remains visible throughout every cinematic clip.
- **Audio:** the existing one-piece Piper narration master is created
  independently, then muxed once after every segment is encoded.

Time is represented as **24-fps integer frames** derived from actual synthesized
speech duration. A three-beat background is encoded once as a single video
segment with the sum of all three beat frame counts. The overlay timeline
changes at each original beat boundary. Background fades into and out of dark
over ten frames at cinematic span boundaries; neighboring still beats use
compatible fades. This is a **dip-to-dark transition, not yet a true xfade**
between two pieces of footage. The non-cinematic original render remains a
fallback when the environment variable is absent.

## Operator-only opt-in

The code is guarded by exactly the same restricted private VPS mode as the
previous Piper preview. To activate it, an operator must separately create an
absolute private manifest containing verified, locally stored and manually
rights-reviewed videos. A manifest never automatically grants publication
rights. **No videos have been selected or approved by this change.**

Set `VNS_CINEMATIC_MEDIA_MANIFEST=/absolute/private/manifest.json` alongside
the existing manual `--save-local` Piper invocation. The legacy single-beat
`VNS_PRIVATE_MEDIA_MANIFEST` and cinematic manifest **cannot be used together**.

The cinematic JSON manifest follows `docs/P3_MEDIA_INTAKE.md`, with every
existing approval, provenance, `motifId`, SHA-256, license and capture date
field intact. Add `endSceneId` to each H264 MP4 background asset. For example,
one approved MP4 with `sceneId: "beat-15"` and
`endSceneId: "beat-17"` occupies three consecutive original P3 visual beats.
It has to be long enough for all three measured durations **plus 0.1 s**;
the renderer refuses to freeze the last frame, loop, stretch or repeat a clip.
It also refuses:
- repeated byte hashes, IDs, source motifs or overlapping spans;
- any shot that would cover one of the six SHA-pinned NASA stills;
- missing permissions, missing license evidence or changed media hashes;
- input video below 640 × 360, non-H264 video or over three beats;
- anything except local, vetted MP4 files inside the private asset root.

All source audio is discarded; only the continuous Piper narration is used.
The existing story review, rights, upload and publication gates remain
`false`. No new network calls, YouTube uploads or website endpoints exist.

## CI validation

The P3 workflow generates its own short synthetic moving image and sine-wave
audio fixture; it does not use any outside footage. It tests three overlay
windows, escaping, exact 144 frames / six seconds, 1280 × 720 output,
one H264 video stream, **no imported soundtrack**, duration,
overlap rejection, duplicate hash detection, source-length refusal and
resistance to placing footage over reserved photos. The existing 19-scene
Piper proof and original three-second encoder test remain unchanged.

## Review before rollout

- The P3-09 branch is **stacked on unmerged P3-08**; do not deploy it directly
  to the VPS or merge it out of order.
- A green CI proves the short synthetic compositor and legacy P3 smoke, not
  that a real licensed 60–90-second NASA file is available or visually suitable.
- A full private VPS episode and subjective motion, pacing and fade inspection
  are still required.
- Future work: true background-to-background cross-dissolves, additional
  freely licensed footage, motion infographic animation, perceptual
  near-duplicate video-frame checks and more varied overlay layouts.
