#!/usr/bin/env node
/**
 * Offline NASA ozone footage inspector. Identifies candidate source URLs and
 * prints a deliberately UNAPPROVED manifest draft. No download, rights grant,
 * render, upload, or publication; operator must review the original footage.
 *
 * Usage: node scripts/p3_nasa_ozone_source_scout.mjs <candidate-id> </absolute/local/video.mp4>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, extname } from "node:path";

export const NASA_OZONE_VIDEO_CANDIDATES = Object.freeze({
  "ozonewatch-2026-southern": Object.freeze({
    page: "https://ozonewatch.gsfc.nasa.gov/multimedia/index.html",
    download: "https://ozonewatch.gsfc.nasa.gov/ozone_maps/movies/" +
      "OZONE_D2026-07-01%25P1D_G%5E1280X720.IOMPS_PNPP_V21_MMERRA2_LSH.mp4",
    credit: "NASA GSFC Ozone Watch / Suomi NPP OMPS; MERRA-2",
    licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    observationLabel: "Southern Hemisphere ozone, 2026 seasonal sequence; extent and end date require frame review",
    note: "Directory lists a file modified 2026-10-12; that is not proof of the last observation date.",
    suggestedStart: "beat-15",
  }),
  "nasa-svs-1979-2025": Object.freeze({
    page: "https://svs.gsfc.nasa.gov/31392/",
    download: "https://svs.gsfc.nasa.gov/vis/a030000/a031300/a031392/" +
      "ozone_hole_max_area_1979-2025_1080p.mp4",
    credit: "NASA SVS / Marit Jentoft-Nilsen (Global Science and Technology, Inc.)",
    licenseUrl: "https://svs.gsfc.nasa.gov/help/",
    observationLabel: "Historic annual Antarctic ozone observations, 1979–2025; NOT 2026 footage",
    note: "The visualization is about past observations, not future projections or the 2026 season.",
    suggestedStart: "beat-15",
  }),
});
const MAX_BYTES = 150 * 1024 * 1024;

export async function inspectNasaOzoneCandidate({candidateId, file}) {
  assert.ok(Object.hasOwn(NASA_OZONE_VIDEO_CANDIDATES, candidateId),
    "Only enumerated NASA source candidates are supported");
  assert.ok(typeof file === "string" && isAbsolute(file) &&
    extname(file).toLowerCase() === ".mp4",
  "Use an absolute local .mp4 path (no URLs)");
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() &&
    info.size > 1000 && info.size < MAX_BYTES, "Invalid or unsafe local clip");
  const actual = await realpath(file);
  const digest = createHash("sha256").update(await readFile(actual)).digest("hex");
  const result = spawnSync("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file,pipe",
    "-show_entries", "format=duration:stream=codec_name,codec_type,width,height",
    "-of", "json", actual,
  ], {encoding: "utf8", timeout: 15000, maxBuffer: 512 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"}});
  assert.equal(result.status, 0, "ffprobe could not inspect NASA candidate");
  const data = JSON.parse(result.stdout);
  const videos = data.streams.filter(s => s.codec_type === "video");
  assert.equal(videos.length, 1, "Expected one video track");
  assert.equal(videos[0].codec_name, "h264", "Cinematic P3 supports H264 only");
  assert.ok(videos[0].width >= 640 && videos[0].height >= 360);
  const durationSeconds = Number(data.format.duration);
  assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 1 &&
    durationSeconds <= 900);
  const source = NASA_OZONE_VIDEO_CANDIDATES[candidateId];
  const draft = {
    schemaVersion: 1,
    assetRoot: dirname(actual),
    assets: [{
      id: "nasa-ozone-" + candidateId,
      motifId: "nasa-ozone-" + candidateId,
      kind: "video",
      path: actual,
      sha256: digest,
      sceneId: source.suggestedStart,
      endSceneId: source.suggestedStart,
      scientificVisualization: true,
      compositionMode: "science-safe",
      sourceUrl: source.page,
      creator: "NASA",
      credit: source.credit,
      captureDate: "REQUIRES_REVIEW",
      licenseUrl: source.licenseUrl,
      licenseEvidence: "REQUIRES_HUMAN_SOURCE_AND_RIGHTS_REVIEW",
      rightsReviewedBy: "PENDING",
      rightsReviewedAt: "REQUIRES_REVIEW",
      rightsApproved: false,
      editorialApproved: false,
      thirdPartyRightsCleared: false,
    }],
  };
  return {
    status: "INSPECTED_UNAPPROVED",
    sourceId: candidateId,
    sourcePage: source.page,
    directDownload: source.download,
    observationLabel: source.observationLabel,
    note: source.note,
    media: {sha256: digest, bytes: info.size, durationSeconds,
      width: videos[0].width, height: videos[0].height,
      codec: videos[0].codec_name,
      sourceAudioTracks: data.streams.filter(s => s.codec_type === "audio").length},
    editorAction: "Review the original frames, observation range, licensing and fit to the narrated beat; never approve just because the file hash matches.",
    durationGuard: "Clip must exceed the sum of each selected narration beat by 0.1 s; do not loop or stretch.",
    draft,
  };
}

if (process.argv[1] && import.meta.url.endsWith("/" + process.argv[1].split("/").at(-1))) {
  assert.equal(process.argv.length, 4,
    "Usage: node scripts/p3_nasa_ozone_source_scout.mjs <candidate-id> </absolute/local/video.mp4>");
  console.log(JSON.stringify(await inspectNasaOzoneCandidate({
    candidateId: process.argv[2], file: process.argv[3],
  }), null, 2));
}
