#!/usr/bin/env node
/**
 * P3-18 private playable DESIGN movie from operator-audited still JPEGs.
 *
 * Not the original NASA movies, not a rights approval, not a release.
 * The 3 informational ozone screenshots and the October 4 Dobson map
 * are 100% opaque, ungraded and free of editorial text overlays.
 * Actual source clips remain INSPECTED_UNAPPROVED and unchanged.
 */
import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {createReadStream} from "node:fs";
import {spawnSync} from "node:child_process";
import {userInfo} from "node:os";
import {
  lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat,
  statfs, writeFile,
} from "node:fs/promises";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {loadOzonePilot, synthesizeMinute} from "./p3_ozone_minute_private_pilot.mjs";

const FPS = 24;
const PREVIEWS = "/home/ap/videonews-previews";
const AUDIT = join(PREVIEWS, "p3-18-real-source-audit");
const STORYBOARD = join(PREVIEWS, "p3-18-centered-storyboard-v2");
const INTAKE = "/home/ap/vns-p3-18-private-candidates/ozone-pilot-UNAPPROVED.json";

function run(name, args, timeout = 180000) {
  const result = spawnSync(name, args, {
    shell: false, encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  if (result.error || result.status !== 0) throw new Error(
    name + " failed: " + (result.error?.code ?? result.status) +
    " " + String(result.stderr).slice(-1600));
  return result.stdout;
}

async function digest(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

function probe(path) {
  return JSON.parse(run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,nb_frames",
    "-of", "json", path,
  ], 20000));
}

export const DESIGN_SCENES = Object.freeze([
  {beat: 1, kind: "atmosphere", name: "storyboard-beat-01.png"},
  {beat: 2, kind: "atmosphere", name: "storyboard-beat-02.png"},
  {beat: 3, kind: "atmosphere", name: "storyboard-beat-03.png"},
  {beat: 4, kind: "dated-ozone-samples", candidateId: "nasa-ozone-video-2026"},
  {beat: 5, kind: "science-map-still", candidateId: "nasa-ozone-map-2026"},
  {beat: 6, kind: "atmosphere", name: "storyboard-beat-06.png"},
]);

function ffEncodeStill(source, output, frames, moving) {
  assert.ok(Number.isInteger(frames) && frames > 0);
  const base = "scale=1280:720:force_original_aspect_ratio=decrease," +
    "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x000000,setsar=1";
  const filter = moving
    ? base + ",zoompan=z='min(1.0+on*0.00012,1.032)':" +
      "x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=1280x720:fps=24," +
      "format=yuv420p"
    : base + ",format=yuv420p";
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-threads", "1", "-filter_complex_threads", "1",
    "-loop", "1", "-framerate", String(FPS), "-protocol_whitelist", "file,pipe",
    "-i", source,
    "-vf", filter, "-frames:v", String(frames), "-r", String(FPS),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-threads:v", "1", "-pix_fmt", "yuv420p", "-an",
    "-movflags", "+faststart", output,
  ], 150000);
  const v = probe(output).streams.find(x => x.codec_type === "video");
  assert.equal(Number(v?.nb_frames), frames, "Unexpected still-derived movie frame count");
}

function concatCopies(files, output) {
  const sources = files.flatMap((file) => ["-i", file]);
  const graph = files.map((_, i) => "[" + i + ":v]settb=AVTB," +
    "setpts=PTS-STARTPTS[v" + i + "]").join(";") +
    ";" + files.map((_, i) => "[v" + i + "]").join("") +
    "concat=n=" + files.length + ":v=1:a=0[out]";
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-threads", "1", "-filter_complex_threads", "1",
    ...sources, "-filter_complex", graph, "-map", "[out]",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-threads:v", "1", "-r", String(FPS), "-pix_fmt", "yuv420p",
    "-an", "-movflags", "+faststart", output,
  ], 180000);
}

function renderAtmosphereCrossfades(files, output, secondsPerBeat) {
  const fade = secondsPerBeat <= 1 ? .25 : .5;
  const overlapHalf = fade / 2;
  const offset1 = secondsPerBeat - overlapHalf;
  const offset2 = secondsPerBeat * 2 - overlapHalf;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-threads", "1", "-filter_complex_threads", "1",
    ...files.flatMap(x => ["-i", x]),
    "-filter_complex",
    "[0:v][1:v]xfade=transition=fade:duration=" + fade +
      ":offset=" + offset1 + "[a];" +
    "[a][2:v]xfade=transition=fade:duration=" + fade +
      ":offset=" + offset2 + ",format=yuv420p[out]",
    "-map", "[out]", "-r", String(FPS),
    "-frames:v", String(secondsPerBeat * FPS * 3),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-threads:v", "1", "-pix_fmt", "yuv420p",
    "-an", "-movflags", "+faststart", output,
  ];
  run("ffmpeg", args, 180000);
  assert.equal(Number(probe(output).streams[0].nb_frames), secondsPerBeat * FPS * 3);
}

/**
 * Pure, offline audiovisual image-to-motion renderer. No real-media
 * rights inference is possible here; private runner checks exact inputs.
 * Exported so the CI test can use its own self-produced synthetic stills.
 */
export function renderMovingDesign({scenes, output, directory, secondsPerBeat = 10}) {
  assert.ok([1, 10].includes(secondsPerBeat) && Array.isArray(scenes) &&
    scenes.length === 6);
  assert.ok(scenes.slice(0, 3).every(s => s.kind === "atmosphere" &&
    typeof s.source === "string"));
  assert.equal(scenes[3].kind, "dated-ozone-samples");
  assert.ok(scenes[3].sources?.length === 3);
  assert.equal(scenes[4].kind, "science-map-still");
  assert.equal(scenes[5].kind, "atmosphere");
  const atmo = [];
  const fade = secondsPerBeat <= 1 ? .25 : .5;
  for (let i = 0; i < 3; i++) {
    const extra = i === 1 ? fade : fade / 2;
    const frames = secondsPerBeat * FPS + Math.round(extra * FPS);
    const outputPart = join(directory, "atmospheric-0" + (i + 1) + ".mp4");
    ffEncodeStill(scenes[i].source, outputPart, frames, true);
    atmo.push(outputPart);
  }
  const first30 = join(directory, "crossfaded-atmosphere.mp4");
  renderAtmosphereCrossfades(atmo, first30, secondsPerBeat);

  // Date-stamped NASA scientific frames run by themselves: no atmospheric
  // B-roll, dark overlay, explanatory typography or camera zoom.
  const samples = scenes[3].sources.map((source, i) => {
    const part = join(directory, "ozone-source-sample-0" + (i + 1) + ".mp4");
    const frames = secondsPerBeat * FPS / 3;
    assert.ok(Number.isInteger(frames));
    ffEncodeStill(source, part, frames, false);
    return part;
  });
  const scienceVideo = join(directory, "scientific-dated-samples.mp4");
  concatCopies(samples, scienceVideo);
  assert.equal(Number(probe(scienceVideo).streams[0].nb_frames), secondsPerBeat * FPS);

  const scienceMap = join(directory, "uncropped-original-dobson-map.mp4");
  ffEncodeStill(scenes[4].source, scienceMap, secondsPerBeat * FPS, false);
  const last = join(directory, "atmospheric-closing.mp4");
  ffEncodeStill(scenes[5].source, last, secondsPerBeat * FPS, true);
  concatCopies([first30, scienceVideo, scienceMap, last], output);
  const result = probe(output);
  const v = result.streams.find(s => s.codec_type === "video");
  assert.equal(v?.codec_name, "h264");
  assert.equal(v.width, 1280);
  assert.equal(v.height, 720);
  assert.equal(Number(v.nb_frames), secondsPerBeat * FPS * 6);
  assert.ok(Math.abs(Number(result.format.duration) - 6 * secondsPerBeat) < .12);
  assert.ok(result.streams.every(s => s.codec_type === "video"),
    "Source audio may never enter design proof");
  return result;
}

async function checkPrivateDirectory(path) {
  const st = await lstat(path);
  assert.ok(st.isDirectory() && !st.isSymbolicLink());
  assert.equal(st.uid, process.getuid());
  assert.equal(st.mode & 0o077, 0);
  assert.equal(await realpath(path), path);
}

async function preflight() {
  assert.ok(process.env.CI !== "true" &&
    process.env.GITHUB_ACTIONS !== "true" &&
    process.env.VNS_VPS_PREVIEW_APPROVED === "PRIVATE_REVIEW_ONLY" &&
    userInfo().username === "ap" &&
    typeof process.getuid === "function" &&
    process.getuid() === 1000,
  "Only explicit private ap VPS preview is permitted");
  await checkPrivateDirectory(PREVIEWS);
  await checkPrivateDirectory(AUDIT);
  await checkPrivateDirectory(STORYBOARD);
  const available = await statfs(PREVIEWS);
  assert.ok(available.bavail * available.bsize >= 2 * 1024 ** 3,
    "At least 2GiB free disk must be available");
  const receiptPath = join(AUDIT, "source-audit-receipt.json");
  const storyboardReceiptPath = join(STORYBOARD, "storyboard-receipt.json");
  const [report, board, intake, {story, catalog}] = await Promise.all([
    readFile(receiptPath, "utf8").then(JSON.parse),
    readFile(storyboardReceiptPath, "utf8").then(JSON.parse),
    readFile(INTAKE, "utf8").then(JSON.parse),
    loadOzonePilot(),
  ]);
  assert.equal(report.status, "PRIVATE_ASSET_CONTACT_REVIEW_REQUIRED");
  assert.equal(report.assetCount, 5);
  assert.equal(report.realMediaRenderApproved, false);
  assert.equal(report.publicationAllowed, false);
  assert.equal(board.status, "UNAPPROVED_REAL_NASA_STILL_STORYBOARD_ONLY");
  assert.equal(board.publicationAllowed, false);
  assert.equal(board.movingVideoOutputCreated, false);
  assert.equal(board.frames.length, 6);
  assert.equal(board.storyVersion, 2);
  assert.equal(intake.status, "INSPECTED_UNAPPROVED");
  assert.equal(intake.privateUseScope, "DRAFT_UNAPPROVED");
  assert.ok(intake.assets.every(x =>
    x.rightsApproved === false && x.editorialApproved === false &&
    x.thirdPartyRightsCleared === false));
  assert.ok(catalog.candidates.every(x =>
    x.rightsApproved === false && x.editorialApproved === false &&
    x.thirdPartyRightsCleared === false));
  assert.equal(story.publicationAllowed, false);
  assert.equal(await digest(INTAKE), report.sourceIntakeManifestSha256);
  assert.equal(await digest(receiptPath), board.originalAuditSha256);
  const assets = new Map(report.assets.map(x => [x.candidateId, x]));
  assert.equal(assets.size, 5);
  for (const asset of report.assets) {
    assert.equal(asset.rightsReview?.approvalStatus, "INSPECTED_UNAPPROVED");
    assert.equal(asset.rightsReview?.specificReuseRightsConfirmed, false);
    assert.equal(asset.rightsReview?.thirdPartyRightsCleared, false);
    assert.equal(asset.rightsReview?.publicationAllowed, false);
    assert.equal(await digest(asset.originalPath), asset.originalSha256);
    for (const contact of asset.framesSampled) {
      const fullPath = join(AUDIT, contact.name);
      const st = await lstat(fullPath);
      assert.ok(st.isFile() && !st.isSymbolicLink());
      assert.equal(await digest(fullPath), contact.sha256);
    }
  }
  const boardFrames = board.frames.map(b => b.name);
  for (const frame of board.frames) {
    const path = join(STORYBOARD, frame.name);
    const st = await lstat(path);
    assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(await digest(path), frame.sha256);
  }
  const ozone = assets.get("nasa-ozone-video-2026");
  const map = assets.get("nasa-ozone-map-2026");
  assert.ok(ozone?.framesSampled.length === 3 && map?.framesSampled.length === 1);
  const boardImage = i => join(STORYBOARD, boardFrames[i]);
  const realContact = (asset, i) => join(AUDIT, asset.framesSampled[i].name);
  return {
    story, report, board, receiptPath, storyboardReceiptPath,
    scenes: [
      {kind:"atmosphere",source:boardImage(0)},
      {kind:"atmosphere",source:boardImage(1)},
      {kind:"atmosphere",source:boardImage(2)},
      {kind:"dated-ozone-samples",sources:[0,1,2].map(i=>realContact(ozone,i))},
      {kind:"science-map-still",source:realContact(map,0)},
      {kind:"atmosphere",source:boardImage(5)},
    ],
  };
}

async function renderPrivate() {
  const p = await preflight();
  const voiceConfigured = Boolean(process.env.VNS_PIPER_PYTHON &&
    process.env.VNS_PIPER_MODEL);
  assert.ok((process.env.VNS_PIPER_PYTHON == null &&
    process.env.VNS_PIPER_MODEL == null) ||
    voiceConfigured, "Set BOTH VNS_PIPER_PYTHON and VNS_PIPER_MODEL or neither");
  const staging = await mkdtemp(join(PREVIEWS, ".p3-18-motion-staging-"));
  let finalized = false;
  try {
    const work = join(staging, "work");
    await mkdir(work, {mode: 0o700});
    const video = join(work, "video-only-60s.mp4");
    renderMovingDesign({scenes: p.scenes, output: video, directory: work});
    const final = join(staging, "p3-18-private-moving-design-60s.mp4");
    let voiceReceipts = [], voiceUsed = false;
    if (voiceConfigured) {
      const voice = await synthesizeMinute(p.story, work);
      voiceReceipts = voice.receipts;
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", video, "-i", voice.audio,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
        "-t", "60", "-movflags", "+faststart", final,
      ], 180000);
      voiceUsed = true;
    } else {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", video, "-map", "0:v:0", "-c:v", "copy", "-an",
        "-movflags", "+faststart", final,
      ], 60000);
    }
    const media = probe(final);
    const videoStream = media.streams.find(s => s.codec_type === "video");
    assert.equal(Number(videoStream.nb_frames), 1440);
    assert.ok(Math.abs(Number(media.format.duration)-60) < .15);
    const audio = media.streams.filter(s => s.codec_type === "audio");
    assert.equal(audio.length, voiceUsed ? 1 : 0);
    if (voiceUsed) assert.equal(audio[0].codec_name, "aac");
    const report = {
      schemaVersion:1,
      status:"PRIVATE_SNAPSHOT_DERIVED_MOVING_DESIGN_PROOF_ONLY",
      privateUseScope:"P3_18_UNAPPROVED_NASA_CONTACT_IMAGES_ONLY",
      publicationAllowed:false,actualNasaVideosUsed:false,
      originalNasaSourcesModified:false,
      originalPiperModelUsed:voiceUsed,
      piperCommercialUseApproved:false,modelVoicePrivateDemonstrationOnly:true,
      humanVisualApproval:false,
      genuineOzoneContinuousMotion:false,
      scientificInformationRenderedWithoutOverlay:true,
      actualFrames:1440,durationSeconds:60,
      originalAuditSha256:await digest(p.receiptPath),
      originalStoryboardSha256:await digest(p.storyboardReceiptPath),
      sourceImages:p.scenes.map((x,i)=>({
        beat:i+1,type:x.kind,
        imageFiles:x.sources??[x.source],
      })),
      narration:voiceReceipts,
      video:{name:"p3-18-private-moving-design-60s.mp4",sha256:await digest(final)},
    };
    await writeFile(join(staging, "review-receipt.json"),
      JSON.stringify(report,null,2)+"\n",{mode:0o600,flag:"wx"});
    await rm(work,{recursive:true,force:true});
    const dest = join(PREVIEWS,"p3-18-moving-design-" +
      new Date().toISOString().replace(/[-:.]/g,"").slice(0,15) +
      "-" + randomBytes(4).toString("hex"));
    await rename(staging,dest);
    finalized=true;
    console.log("P3_18_MOVING_PRIVATE_FILM=" + join(dest,report.video.name));
    console.log("P3_18_MOVING_PRIVATE_RECEIPT=" + join(dest,"review-receipt.json"));
    console.log("P3_18_MOVING_PRIVATE_SHA256=" + report.video.sha256);
    console.log("VOICE=" + (voiceUsed?"PINNED_PIPER_PRIVATE_DEMO":"NONE"));
    console.log("REAL_NASA_SOURCE_VIDEO_USED=NO; PUBLICATION_ALLOWED=NO");
  } finally {
    if (!finalized) await rm(staging,{recursive:true,force:true});
  }
}

const invoked = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  assert.equal(process.argv.length,3);
  assert.equal(process.argv[2],"--save-private");
  await renderPrivate();
}
