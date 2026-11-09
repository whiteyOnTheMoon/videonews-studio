# VideoNewsStudio – VPS-only private preview rendering and downloads

**Decision 2026-11-09.** Tracking #482, feature PR #481 (P4-01). The operator requires the actual MP4 to be rendered on the **existing VPS**, not in GitHub Actions, and to persist for private download.

## Current implementation boundary

- `scripts/vps_p3_explained_preview.mjs` implements a **one-shot, manually activated, local-only preview** using original in-repository graphics, the curated English ozone script and a _temporary low-quality_ eSpeak narrator. It is **not** a production-quality voice or a publishing renderer.
- The script refuses execution as root, from GitHub Actions, when `CI=true`, for any user other than `ap`, or without the literal one-shot operator opt-in environment variable. It has no upload, media ingestion, billing, YouTube, publishing or database connection.
- GitHub now compiles/tests source and refuses renderer execution; it **must not create video files** in CI for this preview.
- A successful local MP4 is kept privately at **`/home/ap/videonews-previews/`**, outside `/home/ap/www/` and any static document root. Directory permissions must be `0700`, output `0600`, root-owned/symlinked storage is refused.
- At least 1 GiB disk free is required; a fixed exclusive `.render-once.lock` prevents concurrent operator invocations. The script never clears old MP4s. Temporary media files are removed. A stale lock after an interrupted run requires **manual inspection** before removal.
- The renderer uses a fixed voice, fixed curated source manifest and a constrained encoder command, not arbitrary filenames or FFmpeg arguments from HTTP requests. Outputs retain visible `PREVIEW – NOT FOR PUBLICATION` labels.
- Only an **explicitly operator-authorized technical non-public preview exception** is implemented. Editorial, source, rights, production render, upload and publication approvals all remain false.

## Deployment preflight – not a command to run automatically

Before any VPS execution, review/approve the PR, check spare disk, RAM, CPU, installed `node`, `ffmpeg`, `ffprobe`, `rsvg-convert`, `espeak-ng`, and the complete checkout **as user `ap`**. Make sure the project already has an approved local build of `@vns/shared`. No automatic package installation, service restart, root escalation, network fetch or deployment is authorized by creating this documentation.

Only once the reviewed branch has been deployed **through the operator's separate approved VPS procedure**:

```bash
# Run as ap, never as root; do not paste secrets into chat.
umask 077
cd /home/ap/www/videonews-studio
id -un
node --version
command -v ffmpeg
command -v ffprobe
command -v rsvg-convert
command -v espeak-ng
# Existing dependency/build gate must already be available locally.
npm run build --workspace @vns/shared
VNS_VPS_PREVIEW_APPROVED=PRIVATE_REVIEW_ONLY node scripts/vps_p3_explained_preview.mjs
```

The script prints `VNS_PRIVATE_PREVIEW_PATH=/home/ap/videonews-previews/<unique-file>.mp4`, duration, byte count and SHA-256. That path is **not a browser URL** and must not be made publicly accessible.

## Operator download while an authenticated UI is still missing

A separate authenticated HTTPS download route and admin listing are **pending**. Until then, the operator can transfer a selected file through their existing, verified SSH/SFTP workflow, for example (run from an authorized workstation, **not** the VPS):

```bash
scp 'ap@YOUR_ACTUAL_VPS_HOST:/home/ap/videonews-previews/EXACT_RENDERED_FILE.mp4' ./
```

Replace the host and filename with real, verified values; do not guess them or send passwords/keys in chat. Do not copy previews to a public `www` folder or post public object-storage links. Future admin integration must authenticate every download with the named editor session and role checks, reject path traversal, enforce rate limits and file size caps, set `Cache-Control: no-store`, `Content-Disposition: attachment`, and audit who accessed which preview.

**ChatGPT download link limitation:** The GitHub code connector cannot access the VPS filesystem or retrieve video bytes. A `sandbox:/mnt/data/...` link can only be provided once the exact file has actually been brought into this conversation's runtime (e.g. attached/uploaded, or via a separately authorized file-transfer integration). Never fabricate a URL or claim the file was downloaded. A real authenticated HTTPS link may be shared when the corresponding protected route is verified and reachable.

## Retention and security

- Keep preview files until the operator approves a retention period and a deletion mechanism. Monitor disk growth: a 9–10 minute H264 file may vary in size by codec/complexity.
- No GitHub artifact upload, publicly routed video or third-party storage is required.
- A successful technical render does **not** grant news, license or YouTube publishing rights.
- The current VPS has not been inspected, changed, deployed to or rendered on by this PR.
