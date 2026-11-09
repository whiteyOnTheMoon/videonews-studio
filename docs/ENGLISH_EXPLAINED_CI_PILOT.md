# Earth & Climate Explained — English 8–10 minute VPS preview (P4-01/#480, #482)

**Decision updated 2026-11-09:** The operator requires all real test videos to be generated and kept on the **existing VPS**, not in GitHub Actions. See [VPS_PRIVATE_PREVIEW_RUNBOOK.md](VPS_PRIVATE_PREVIEW_RUNBOOK.md). This is a **private, editor-unapproved, nonpublishable** technical preview, not a YouTube-ready production video.

## Editorial format and current source package

The mandatory seven-part script order is documented in [EXPLAINED_SCRIPT_STRUCTURE_V1.md](EXPLAINED_SCRIPT_STRUCTURE_V1.md): The Hook → The Basics → What Happened? → Why Is It Happening? → Why It Matters → What's Next? → The Takeaway. The illustrative timestamps are **guidelines, not per-section quotas**.

The curated, manually authored script lives at `content/news/ozone-2026-explained-en.json` and contains **1,264 spoken English words and 19 original graphic beats**. Its six source records are:

- [NOAA/NASA joint analysis, 2026-11-04](https://www.noaa.gov/news-release/noaa-nasa-release-measurements-of-2026-ozone-hole) – seasonal mean 25 million km² (Sep 7–Oct 13, 2026), seventh-largest out of 48 years, peak day 27.1 million km² on September 18, South Pole ozone minimum 105 DU on October 17 (versus 92 DU in October 2006).
- [NASA Earth Observatory, 2026-11-09](https://science.nasa.gov/earth/earth-observatory/ozone-hole-reaches-its-2026-maximum/) – shared NASA/NOAA measurement story **not a second independent confirmation**.
- [Copernicus CAMS, 2026-09-16](https://atmosphere.copernicus.eu/copernicus-ozone-hole-reaches-notable-threshold-early-again-area-increases-above-average-2026) – separate European monitoring.
- [DLR, 2026-10-26](https://www.dlr.de/en/eoc/latest/news/2026/ozone-hole-2026-one-of-the-largest-in-years) – independent satellite/meteorological context, not interchangeable measurements.
- [US EPA, ozone science](https://www.epa.gov/ozone-layer-protection/basic-ozone-layer-science) – educational background.
- [UNEP Ozone Secretariat](https://ozone.unep.org/facts-and-figures-ozone-protection) – long-term recovery context and conditional projections.

These are _manual provenance notes_, not live source ingestion or editorial fact-check clearance.

## Technical implementation

- The shared seven-section assertion verifies format metadata, declared `en-US` language, complete order and nonempty narration; it does **not** verify actual English or claims.
- The shared frame timeline derives variable scene lengths from measured WAV durations and pads only the end of individual sections; there are no rigid section timing slots.
- `scripts/vps_p3_explained_preview.mjs` only runs after an explicit operator opt-in, as local `ap`, outside CI. It synthesizes a temporary low-quality English eSpeak narration, constructs **one continuous PCM master**, and encodes AAC **once**. It uses the P3-07 original graphics generator, localized English PREVIEW watermarks, `rsvg-convert`, `ffmpeg` and `ffprobe`.
- A successful run requires 8:00–10:00 measured final duration and correct H264/AAC codecs, video frame count, sound length and input/source guards.
- Upon success, it saves a **private persistent MP4** in `/home/ap/videonews-previews`, not inside `www`. The temporary runner directory is still removed. No automated upload or network transfer exists.
- GitHub Actions now builds, checks and tests **code only**, rejecting execution of the VPS renderer; no GitHub Actions video-rendering steps remain in this new preview workflow.

## Historical CI evidence (superseded operation)

The earlier CI-only experiment at commit `184625e1056780427cb5b083165add96e8d452a7` rendered and ffprobe-verified a 570.958-second/9:31 H264/AAC file with 19 scenes and 1,264 spoken words. It was _deleted_ as temporary runner output. Its success demonstrated the media code path, **not** that VPS rendering has been deployed or tested. In response to the updated operator decision, real MP4 generation in GitHub is discontinued for this preview.

## Not yet done

1. Manual approval and review of the new PR head, VPS resource/tool check and explicitly authorized deployment.
2. First actual VPS render, operator listening/review, persistent file retention check.
3. Authenticated admin download endpoint and private preview list; until this exists, operator-only SSH/SFTP transfer is the download method.
4. Secure connector or uploaded file for **direct ChatGPT sandbox attachment**; a VPS filesystem path cannot itself produce a valid chat link.
5. Professional natural English TTS voice, improved visualization and subtitles.
6. Separate factual verification, content rights, commercial rights, independent human editorial decision, production render/upload gates and YouTube release readiness.

All editorial/asset/production/upload/publication approvals remain false. No code or documentation change here authorizes public publication.
