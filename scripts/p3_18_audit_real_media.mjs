#!/usr/bin/env node
/**
 * P3-18 PRIVATE MEDIA AUDIT (never a rendering or rights-approval tool).
 * Reads five previously quarantined original files and their deliberately
 * unapproved intake manifest, verifies original SHA-256 bytes, and renders
 * review-only contact JPEGs + source metadata and a rights checklist.
 * No remote calls, downloads, permissions changes, or modifying originals.
 *
 * node scripts/p3_18_audit_real_media.mjs --inspect-private
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {spawnSync} from "node:child_process";
import {
  lstat, mkdir, readFile, realpath, rm, stat, writeFile,
} from "node:fs/promises";
import {userInfo} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const SOURCE_ROOT = "/home/ap/vns-p3-18-private-candidates";
const REVIEW_ROOT = "/home/ap/videonews-previews";
const REVIEW_DIR = join(REVIEW_ROOT, "p3-18-real-source-audit");
const INTAKE = join(SOURCE_ROOT, "ozone-pilot-UNAPPROVED.json");
const CATALOG = new URL("../content/media/p3-18-ozone-pilot-candidate-review.json", import.meta.url);
const FILENAMES = Object.freeze({
  "svs-earth-5570": "svs-earth-5570.mp4",
  "svs-earth-spheres-31365": "svs-earth-spheres-31365.mp4",
  "svs-pace-31365": "svs-pace-31365.mp4",
  "nasa-ozone-map-2026": "nasa-ozone-map-2026.jpg",
  "nasa-ozone-video-2026": "nasa-ozone-video-2026.mp4",
});
const EXPLICIT_EVIDENCE = Object.freeze({
  "svs-earth-5570": {
    releaseDate: "2025-07-21",
    dataDate: "Variable satellite/Blue Marble imagery; source dataset dates to be checked",
    attribution: "NASA SVS / Kel Elkins (USRA); William Putman (NASA/GSFC); Blue Marble courtesy Reto Stockli (NASA/GSFC)",
    sourceChecks: ["SVS 5570 credits and two Blue Marble datasets",
      "No misleading implication of 2026 ozone observations",
      "All logos/persons/audio/third-party elements checked"],
  },
  "svs-earth-spheres-31365": {
    releaseDate: "2026-03-01",
    dataDate: "Multiple datasets; frame-dependent changes every ~27 seconds",
    attribution: "NASA SVS / Marit Jentoft-Nilsen (GST, Inc.); PACE/SWOT/GRACE-FO source credits",
    sourceChecks: ["Inspect 0-20 seconds used in the proposed 60-second film",
      "PACE/SWOT/GRACE-FO component credits and any external partner data",
      "Frame labels, logos, music, and dataset dates documented"],
  },
  "svs-pace-31365": {
    releaseDate: "2026-03-01",
    dataDate: "PACE OCI true color dataset 2024-09-24, not ozone 2026",
    attribution: "NASA SVS / PACE OCI Surface Reflectance v3.1; VIIRS/NPP swaths fill gaps",
    sourceChecks: ["Label as atmospheric illustration, not 2026 ozone measurement",
      "PACE 2024-09-24 and VIIRS/NPP dataset credit captured",
      "Any external source rights or logos independently assessed"],
  },
  "nasa-ozone-map-2026": {
    releaseDate: "Source Earth Observatory page; verify image rendition date",
    dataDate: "2026-10-04 map, NOT the 2026-09-18 maximum",
    attribution: "NASA Earth Observatory / Lauren Dauphin (verify image-specific credit)",
    sourceChecks: ["Check image date 2026-10-04 and embedded legend/scale",
      "Check original rendition, map/data processing and credit",
      "Do not caption as the September 18 maximum"],
  },
  "nasa-ozone-video-2026": {
    releaseDate: "Unknown; check NASA Ozone Watch movie source",
    dataDate: "2026 Southern Hemisphere progression; inspect exact start/end dates",
    attribution: "NASA GSFC Ozone Watch; actual sensors and third-party rights must be checked",
    sourceChecks: ["Read first/mid/last frame calendar dates and color legend",
      "Verify 2026 time coverage and underlying sensors/data attribution",
      "Verify reuse terms of this exact animation; original SHA must remain pinned"],
  },
});

function execute(command, args, timeout = 30000) {
  const p = spawnSync(command, args, {
    shell: false, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  if (p.error || p.status !== 0) {
    throw new Error("AUDIT_TOOL_FAILED: " + command + " status=" + p.status +
      " code=" + (p.error?.code ?? "none") + " stderr=" + String(p.stderr).slice(-1000));
  }
  return p.stdout;
}

function probe(file) {
  return JSON.parse(execute("ffprobe", [
    "-hide_banner", "-v", "error",
    "-protocol_whitelist", "file,pipe",
    "-show_entries",
    "format=duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels",
    "-of", "json", file,
  ], 25000));
}

async function sha256(file) {
  const h = createHash("sha256");
  for await (const data of createReadStream(file)) h.update(data);
  return h.digest("hex");
}

async function privateDirectory(dir) {
  const info = await lstat(dir);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(),
    "Only a real private directory is allowed");
  assert.equal(await realpath(dir), dir, "Private directory must not be redirected");
  assert.equal(info.uid, process.getuid(), "Private directory owner must be ap");
  assert.equal(info.mode & 0o077, 0, "Private directory must be mode 0700");
}

export function auditSampleSeconds(id, seconds) {
  assert.ok(Number.isFinite(seconds) && seconds > 3);
  if (id === "nasa-ozone-video-2026") {
    assert.ok(seconds >= 14.5, "Known ozone video is shorter than inspected");
    return [1, 7, 14];
  }
  assert.ok(id in FILENAMES && id !== "nasa-ozone-map-2026");
  assert.ok(seconds >= 20.4, "Background shorter than planned review");
  return [1, 10, 20];
}

export function createUnapprovedReviewChecklist(candidate) {
  const evidence = EXPLICIT_EVIDENCE[candidate.id];
  assert.ok(evidence && candidate.rightsApproved === false &&
    candidate.thirdPartyRightsCleared === false &&
    candidate.editorialApproved === false,
  "Auditor never accepts approved or unknown catalog entries");
  return {
    sourcePage: candidate.sourcePage,
    sourceFileUrl: candidate.fileUrl ?? null,
    sourceReleaseDate: evidence.releaseDate,
    datasetDateWarning: evidence.dataDate,
    creditToVerify: evidence.attribution,
    manualChecks: evidence.sourceChecks,
    reviewerCheckedAllFrames: false,
    thirdPartyRightsCleared: false,
    specificReuseRightsConfirmed: false,
    sourceDateVerified: false,
    scienceLegendReadabilityConfirmed: false,
    publicationAllowed: false,
    approvalStatus: "INSPECTED_UNAPPROVED",
  };
}

export async function makeReviewFrame(file, output, second, isStill = false) {
  assert.ok(Number.isFinite(second) && second >= 0);
  assert.ok(typeof isStill === "boolean" && (!isStill || second === 0),
    "Single-image audit frame must use t=0");
  // Image2 JPEGs are single-frame inputs. Input-seeking with -ss 0 can cause
  // FFmpeg to exit 0 with zero output frames on a genuine one-image source.
  // Loop only still-image inputs long enough to output ONE review JPEG.
  // Video sampling continues to use the exact original timestamp without looping.
  const inputOptions = isStill
    ? ["-loop", "1", "-framerate", "1"]
    : ["-ss", second.toFixed(3)];
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...inputOptions, "-protocol_whitelist", "file,pipe", "-i", file,
    "-vf", "scale=960:540:force_original_aspect_ratio=decrease," +
      "pad=960:540:(ow-iw)/2:(oh-ih)/2:color=0x06101b,setsar=1",
    "-frames:v", "1", "-q:v", "3", output,
  ], 45000);
  assert.ok((await stat(output)).size > 1000, "Empty review contact frame");
}

async function verifyFiles(catalog, draft) {
  assert.equal(catalog.status, "INSPECTED_UNAPPROVED");
  assert.equal(catalog.candidates.length, 5);
  assert.equal(draft.status, "INSPECTED_UNAPPROVED");
  assert.equal(draft.privateUseScope, "DRAFT_UNAPPROVED");
  assert.equal(draft.publicationAllowed, false);
  assert.equal(draft.assetRoot, SOURCE_ROOT);
  assert.ok(Array.isArray(draft.assets) && draft.assets.length === 5);
  const candidates = new Map(catalog.candidates.map(item => [item.id, item]));
  const seen = new Set(), verified = [];
  for (const asset of draft.assets) {
    const candidate = candidates.get(asset.candidateId);
    assert.ok(candidate && !seen.has(candidate.id), "Wrong/duplicate candidate ID");
    seen.add(candidate.id);
    assert.equal(asset.id, candidate.id);
    assert.equal(asset.sourceUrl, candidate.sourcePage);
    assert.equal(asset.role, candidate.role);
    assert.equal(asset.kind, candidate.type);
    assert.equal(asset.sceneId, candidate.sceneId);
    assert.equal(asset.endSceneId, candidate.endSceneId);
    assert.equal(asset.rightsApproved, false);
    assert.equal(asset.editorialApproved, false);
    assert.equal(asset.thirdPartyRightsCleared, false);
    assert.equal(asset.path, join(SOURCE_ROOT, FILENAMES[candidate.id]),
      "Unexpected real source path");
    const info = await lstat(asset.path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 15000 &&
      info.size <= 300 * 1024 * 1024);
    assert.equal(await realpath(asset.path), asset.path);
    const digest = await sha256(asset.path);
    assert.equal(digest, asset.sha256, "Source file changed since intake");
    if (candidate.expectedSha256)
      assert.equal(digest, candidate.expectedSha256, "Pinned NASA digest mismatch");
    const meta = probe(asset.path);
    const streams = meta.streams ?? [];
    const video = streams.find(s => s.codec_type === "video");
    assert.ok(video && video.width >= 640 && video.height >= 360);
    if (asset.kind === "video") {
      assert.equal(video.codec_name, "h264");
      assert.ok(Number(meta.format.duration) >= candidate.expectedMinimumSeconds);
    }
    verified.push({candidate, asset, digest, meta});
  }
  assert.equal(seen.size, 5);
  return verified;
}

async function inspectPrivate() {
  assert.ok(process.env.CI !== "true" && process.env.GITHUB_ACTIONS !== "true" &&
    process.env.VNS_VPS_PREVIEW_APPROVED === "PRIVATE_REVIEW_ONLY" &&
    typeof process.getuid === "function" && process.getuid() === 1000 &&
    userInfo().username === "ap", "ap-only private manual review required");
  await privateDirectory(SOURCE_ROOT);
  await privateDirectory(REVIEW_ROOT);
  const draftInfo = await lstat(INTAKE);
  assert.ok(draftInfo.isFile() && !draftInfo.isSymbolicLink() &&
    draftInfo.size > 500 && draftInfo.size < 256 * 1024);
  const catalog = JSON.parse(await readFile(CATALOG, "utf8"));
  const draft = JSON.parse(await readFile(INTAKE, "utf8"));
  const verified = await verifyFiles(catalog, draft);
  const inventorySha256 = await sha256(INTAKE);

  let owned = false;
  try {
    // mkdir without recursive refuses preexisting review, never replaces evidence.
    await mkdir(REVIEW_DIR, {mode: 0o700});
    owned = true;
    const assets = [];
    for (const {candidate, asset, digest, meta} of verified) {
      const video = meta.streams.find(x => x.codec_type === "video");
      const times = candidate.type === "video"
        ? auditSampleSeconds(candidate.id, Number(meta.format.duration)) : [0];
      const contacts = [];
      for (const [index, seconds] of times.entries()) {
        const name = candidate.id + "-frame-" + String(index + 1).padStart(2, "0") + ".jpg";
        const output = join(REVIEW_DIR, name);
        await makeReviewFrame(asset.path, output, seconds, candidate.type === "photo");
        contacts.push({name, seconds, sha256: await sha256(output)});
      }
      assets.push({
        candidateId: candidate.id, role: candidate.role,
        originalPath: asset.path, originalSha256: digest,
        originalBytes: Number(meta.format.size),
        width: video.width, height: video.height,
        durationSeconds: Number(meta.format.duration) || null,
        sourceVideoCodec: video.codec_name,
        hasSourceAudio: meta.streams.some(x => x.codec_type === "audio"),
        framesSampled: contacts, rightsReview: createUnapprovedReviewChecklist(candidate),
      });
    }
    const receipt = {
      schemaVersion: 1,
      status: "PRIVATE_ASSET_CONTACT_REVIEW_REQUIRED",
      publicationAllowed: false,
      realMediaUsedForPublishedVideo: false,
      realMediaRenderApproved: false,
      activeDownloadWorkers: false,
      sourceIntakeManifestSha256: inventorySha256,
      sourceDirectory: SOURCE_ROOT,
      reviewDirectory: REVIEW_DIR,
      contactsAreResizedEvidenceOnly: true,
      sourceScientificDataMustBeReviewedAtOriginalResolution: true,
      assetCount: assets.length,
      assets,
    };
    const receiptFile = join(REVIEW_DIR, "source-audit-receipt.json");
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + "\n",
      {mode: 0o600, flag: "wx"});
    console.log("P3_18_REAL_ASSET_AUDIT=" + receiptFile);
    console.log("P3_18_REAL_ASSET_COUNT=5; CONTACT_FRAMES=" +
      assets.reduce((n, a) => n + a.framesSampled.length, 0));
    console.log("P3_18_RENDER_APPROVED=NO; PUBLICATION_ALLOWED=NO");
  } catch (error) {
    if (owned) await rm(REVIEW_DIR, {recursive: true, force: true});
    throw error;
  }
}

const invoked = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  assert.equal(process.argv.length, 3);
  assert.equal(process.argv[2], "--inspect-private");
  await inspectPrivate();
}
