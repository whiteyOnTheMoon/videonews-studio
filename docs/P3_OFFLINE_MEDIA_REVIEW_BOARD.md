# P3-13 — Offline episode media review board

The episode library now has a deterministic metadata triage and a private,
offline review board for the editor. This is **not a visual AI model**:
the ranking only compares limited title/description tokens, provider role,
resolution, known clip duration and basic media type. It cannot certify
that a clip shows the spoken event, that footage is current, or that a
provider or individual media item grants rights.

## Design rules

1. Each of the existing 19 original story beats has its own expandable
   section, with separate **NASA scientific-source candidates** and
   **stock contextual B-roll** candidates. Stock footage is never presented
   as a scientific measurement or proof of a news claim.
2. Each candidate shows its creator/credit, official source page, licence
   reference, available date and technical metadata, reasons for its
   ranking, and a clear **human review required** status.
3. Candidate scores are relative, approximate and **metadata-only**.
   The top-ranked asset is a suggestion, not automatically selected.
   If a science scene has no NASA science candidates, the review board
   shows a missing-science-source warning instead of silently treating
   Pexels as scientific evidence.
4. HTML does not embed external CDN images, scripts, fonts, videos or
   tracking. Content Security Policy blocks resource and API loading.
   Official source and licence links open only when the operator clicks.
   Untrusted titles, descriptions and credits are HTML-escaped.
5. Optional visual thumbnails are generated from **already downloaded,
   quarantined** files in this private episode workspace. Every source
   must have an exact SHA-256 match, private local path, media extension,
   quarantine receipt, non-symlink origin, and unpublished/unapproved
   status. FFmpeg generates a small bounded 320×180 JPEG which is
   embedded as a data URL. No external image fetch occurs.
6. Checkboxes permit selecting **one to four** candidates per export,
   with no more than two from one scene and no motif duplication.
   The HTML exports an intentionally **disabled** JSON draft with
   `approvePreviewAcquisition:false`, `allowRendering:false`,
   `allowPublication:false`, an operator placeholder and a placeholder
   requiring a reviewed, exact official direct-file URL. The P3-12
   downloader will reject this file until separately completed and
   explicitly approved by the operator.
7. Nothing is deleted by generating the board. The P3-10 final-export
   hash and explicit cleanup approval still gate temporary-file removal.

## Operator-only preview (no downloads, no publication)

Run on a Git worktree of P3-13 with an existing private (0700) episode
workspace and an already generated P3-10/P3-11 library:

```bash
node scripts/p3_media_review_board.mjs \
  /absolute/private/workspace/post-editorial-asset-library.json \
  /absolute/private/workspace
```

It writes a 0600 `episode-media-review-board.html`. Open this file
**locally** with your browser; it is not served publicly. The command
does not query external providers and never downloads files.

To include already quarantined material in visual thumbnails:

```bash
node scripts/p3_media_review_board.mjs \
  /absolute/private/workspace/post-editorial-asset-library.json \
  /absolute/private/workspace \
  --receipt=/absolute/private/workspace/quarantine-receipt.json
```

This is an alternative invocation in a **fresh** episode workspace or
after an operator deliberately archives the earlier HTML file; the CLI
does not overwrite an existing board. The receipt is created by the
P3-12 operator-only download command. Only local files with the
correct hash and the expected quarantine layout can appear as previews.

The candidate board never exposes an active publisher control,
network-triggering thumbnail, or automatic asset license. If the
operator wants to proceed, they must open the provider source link,
inspect the actual footage and media-specific licence and date,
and separately edit the disabled JSON draft for a controlled
P3-12 quarantine step.

## Confidence and limitations

- Keyword matching can recommend an irrelevant item that happens to
  contain the correct words, or miss a suitable image with sparse
  metadata. These are *triage hints*, not trained visual similarity.
- Metadata duration does not substitute for the 24fps narration
  frame budget checks in the P3-09 Cinematic Timeline.
- SHA-256 catches byte changes, but different crops or encodings of
  the same motif need a human-set shared motif ID. Perceptual duplicate
  detection is still future work.
- Source photos/video still require review for third-party copyright,
  people, brand marks, endorsement and scientific context.
- Pexels sources with signed third-party video URLs remain blocked by
  the P3-12 downloader until bound to authenticated API source metadata.
- There is no automatic news-worker trigger, full-episode VPS render,
  or approval for public upload. The Piper voice remains a private demo.

## CI

The offline asset-library workflow verifies score grouping, deterministic
ordering, missing science flags, unchanged rights gates, duplicate motif
and identity refusals, malicious markup escaping, network-isolating CSP,
an actual FFmpeg thumbnail from generated local H.264 test footage,
tampered quarantine paths/hashes, and the output HTML privacy/permissions.
The existing full P3 Piper and cinematic codec smoke workflows also run.

**Branch dependency:** P3-13 is stacked on P3-12, P3-11, P3-10,
P3-09 and P3-08. Do not merge or deploy out of order.
