#!/usr/bin/env node
/**
 * P3-18: 60-second authentic English editorial pilot, fail-closed for REAL
 * reviewed, offline media. No network, download, upload or rights inference.
 * With --check-editorial, validates the publication-blocked 2026 news script.
 * With --save-private (ap-only), renders all 6 spoken beats with verified
 * pinned Piper demo model, SHA-checked, individually human-approved sources.
 */
import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {spawnSync} from "node:child_process";
import {constants as fsConstants} from "node:fs";
import {
  copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat,
  statfs, writeFile,
} from "node:fs/promises";
import {tmpdir, userInfo} from "node:os";
import {isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {encodeLayeredSequence, loadLayeredTimeline} from "./p3_layered_cinematic_composition.mjs";
import {PILOT_PRESENTATIONS} from "./p3_minute_editorial_layout.mjs";

const STORY_URL = new URL("../content/news/ozone-2026-minute-editorial-pilot-en.json", import.meta.url);
const CATALOG_URL = new URL("../content/media/p3-18-ozone-pilot-candidate-review.json", import.meta.url);
const VOICE_SHA = "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f";
const VOICE_FILE = "en_US-lessac-medium.onnx";
const FPS = 24;
const FRAMES = 1440;
const SECONDS = 60;
const PARENT = "/home/ap/videonews-previews";
const MAX_MANIFEST = 256 * 1024;
process.umask(0o077);

function execute(name, args, timeout = 360000) {
  const result = spawnSync(name, args, {
    shell: false, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  if (result.error || result.status !== 0) throw new Error(
    "P3_18_COMMAND_FAILED " + name + " status=" + result.status +
    " code=" + (result.error?.code ?? "none") +
    " stderr=" + (result.stderr ?? "").slice(-1400));
  return result.stdout;
}

function metadata(file) {
  return JSON.parse(execute("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file,pipe",
    "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,nb_frames,channels,sample_rate",
    "-of", "json", file,
  ], 20000));
}

async function hash(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function loadOzonePilot() {
  const story = JSON.parse(await readFile(STORY_URL, "utf8"));
  const catalog = JSON.parse(await readFile(CATALOG_URL, "utf8"));
  assert.equal(story.schemaVersion, 1);
  assert.equal(story.id, "ozone-2026-minute-editorial-pilot-en");
  assert.equal(story.language, "en-US");
  assert.equal(story.editorialApproved, false);
  assert.equal(story.publicationAllowed, false);
  assert.equal(story.fps, FPS);
  assert.equal(story.durationFrames, FRAMES);
  assert.equal(story.beats.length, 6);
  assert.equal(story.visualDesignVersion, 2,
    "P3-18 requires revised science-first center-stage editorial layout");
  assert.equal(story.beats[3].visual?.presentation, "science-stage");
  assert.equal(story.beats[3].visual?.scienceRole, "science-inset");
  assert.equal(story.beats[4].visual?.presentation, "science-stage");
  assert.equal(story.beats[4].visual?.scienceRole, "image-card");
  assert.equal(story.beats[5].visual?.presentation, "closing");
  assert.equal(catalog.status, "INSPECTED_UNAPPROVED");
  assert.equal(catalog.publicationAllowed, false);
  assert.equal(catalog.candidates.length, 5);
  const urls = new Map(story.sources.map(source => [source.id, source.url]));
  assert.equal(urls.size, story.sources.length);
  assert.ok(urls.size >= 2);
  const presentations = new Set(PILOT_PRESENTATIONS);
  let words = 0;
  for (const [index, beat] of story.beats.entries()) {
    assert.equal(beat.id, "beat-" + String(index + 1).padStart(2, "0"));
    assert.equal(beat.seconds, 10);
    assert.ok(Array.isArray(beat.sources) && beat.sources.length > 0 &&
      beat.sources.every(sourceId => urls.has(sourceId)), "Uncited editorial beat");
    assert.ok(presentations.has(beat.visual?.presentation));
    assert.ok(beat.visual?.title.length >= 8 && beat.visual?.title.length <= 72);
    assert.ok(typeof beat.visual?.body === "string");
    assert.ok(!/[<>\r\n]/.test(beat.narration), "Narration cannot contain markup");
    const length = beat.narration.split(/\s+/).filter(Boolean).length;
    assert.ok(length >= 15 && length <= 24, "Beat must sound natural within 10 seconds");
    words += length;
  }
  assert.ok(words >= 105 && words <= 140, "60-second pilot must have 105–140 words");
  const candidates = new Map(catalog.candidates.map(asset => [asset.id, asset]));
  assert.equal(candidates.size, catalog.candidates.length);
  assert.equal(catalog.candidates.filter(x => x.role === "background").length, 3);
  assert.equal(catalog.candidates.filter(x => x.role !== "background").length, 2);
  assert.ok(catalog.candidates.every(asset =>
    asset.rightsApproved === false && asset.thirdPartyRightsCleared === false &&
    asset.editorialApproved === false), "Catalog must NEVER approve real sources");
  const media = [...story.mediaPlan.background, ...story.mediaPlan.foreground];
  assert.equal(media.length, 5);
  assert.deepEqual(story.mediaPlan.foreground.map(x => [x.candidateId, x.sceneId]), [
    ["nasa-ozone-video-2026", "beat-04"],
    ["nasa-ozone-map-2026", "beat-05"],
  ], "Scientific animation must precede the independently colored Dobson map");
  for (const assignment of media) {
    const candidate = candidates.get(assignment.candidateId);
    assert.ok(candidate, "Unknown real candidate");
    assert.equal(assignment.role, candidate.role);
    assert.equal(assignment.sceneId, candidate.sceneId);
    assert.equal(assignment.endSceneId, candidate.endSceneId);
  }
  return {story, catalog, words};
}

export function requirePilotMediaScope(manifest, catalog) {
  assert.ok(manifest && manifest.schemaVersion === 1 &&
    manifest.privateUseScope === "P3_18_MANUALLY_APPROVED_EDITORIAL_TEST",
  "Only an explicitly human-reviewed 60-second private manifest can be used");
  assert.ok(Array.isArray(manifest.assets) && manifest.assets.length === 5);
  const candidates = new Map(catalog.candidates.map(item => [item.id, item]));
  const used = new Set();
  for (const asset of manifest.assets) {
    const item = candidates.get(asset.candidateId);
    assert.ok(item && !used.has(item.id), "Unknown or repeated curated pilot media");
    used.add(item.id);
    assert.equal(asset.role, item.role);
    assert.equal(asset.sceneId, item.sceneId);
    assert.equal(asset.endSceneId, item.endSceneId);
    assert.equal(asset.kind, item.type);
    assert.equal(asset.compositionMode, "layered-cinematic");
    assert.equal(asset.sourceUrl, item.sourcePage);
    assert.ok(item.role !== "science-inset" ||
      asset.scientificVisualization === true);
    assert.ok(item.role === "background" &&
      asset.scientificVisualization === false ||
      item.role !== "background");
    assert.ok(!item.expectedSha256 || asset.sha256 === item.expectedSha256,
      "Known NASA file bytes do not match pinned SHA");
    if (item.role === "background") assert.ok(
      asset.atmosphericVisualReview === true &&
      asset.contentClassification === "ILLUSTRATIVE_BACKGROUND",
      "SVS atmosphere footage needs specific visual-review opt-in");
    assert.ok(asset.captureDate !== "2026-11-13",
      "Replace intake placeholder with the real source date");
    assert.ok(typeof asset.sourceDateEvidence === "string" &&
      asset.sourceDateEvidence.length >= 25 &&
      !/pending|placeholder|auto.?approved/i.test(asset.sourceDateEvidence),
    "Scientific/illustrative source date must be documented");
    assert.ok(asset.rightsApproved === true &&
      asset.editorialApproved === true &&
      asset.thirdPartyRightsCleared === true, "Real media is not individually approved");
    assert.ok(typeof asset.licenseEvidence === "string" &&
      asset.licenseEvidence.length >= 30 &&
      !/auto.?approved|ci.fixture|placeholder|pending/i.test(asset.licenseEvidence),
    "A real source-specific rights evidence note is mandatory");
    assert.ok(typeof asset.rightsReviewedBy === "string" &&
      asset.rightsReviewedBy.length >= 3 &&
      !/ci.fixture|synthetic|automatic|pending/i.test(asset.rightsReviewedBy),
    "Named human rights review is required");
    assert.ok(typeof asset.reviewReceipt === "string" &&
      asset.reviewReceipt.length >= 15 &&
      !/pending|placeholder/i.test(asset.reviewReceipt),
    "Real file-specific review receipt is required");
  }
  assert.equal(used.size, 5);
  return true;
}

async function validateOfflineVoice() {
  const python = process.env.VNS_PIPER_PYTHON;
  const model = process.env.VNS_PIPER_MODEL;
  assert.ok(typeof python === "string" && isAbsolute(python));
  assert.ok(typeof model === "string" && isAbsolute(model) &&
    model.endsWith("/" + VOICE_FILE));
  // A standard Python virtualenv may use bin/python -> python3 symlinks.
  // Resolve and check the requested interpreter, while requiring an actual
  // non-symlink model and config whose model bytes match the pinned SHA.
  assert.ok((await stat(python)).isFile(), "Piper interpreter is not a file");
  for (const path of [model, model + ".json"]) {
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
  }
  assert.equal(await hash(model), VOICE_SHA, "Private demo voice model mismatch");
  const config = JSON.parse(await readFile(model + ".json", "utf8"));
  assert.equal(config.language.code, "en_US");
  assert.equal(config.audio.sample_rate, 22050);
  execute(python, ["-m", "piper", "--help"], 15000);
  return {python, model};
}

/** Every full sentence is spoken. No missing words or truncated TTS audio. */
export async function synthesizeMinute(story, root) {
  const {python, model} = await validateOfflineVoice();
  const padded = [];
  const receipts = [];
  for (const [index, beat] of story.beats.entries()) {
    const stem = "spoken-" + String(index + 1).padStart(2, "0");
    const txt = join(root, stem + ".txt");
    const wav = join(root, stem + ".wav");
    const ready = join(root, stem + "-10s.wav");
    await writeFile(txt, beat.narration + "\n", {mode: 0o600, flag: "wx"});
    execute(python, ["-m", "piper", "-m", model, "--length-scale", "1.04",
      "--sentence-silence", "0.2", "--input-file", txt, "-f", wav], 180000);
    const info = metadata(wav);
    const stream = info.streams.find(s => s.codec_type === "audio");
    assert.equal(stream?.codec_name, "pcm_s16le");
    assert.equal(stream.channels, 1);
    const seconds = Number(info.format.duration);
    assert.ok(seconds > 4 && seconds <= 11.1,
      "Piper beat is too long for ten-second editorial timing; revise narration");
    // Never remove any speech; a modest tempo change is allowed if needed.
    const speed = Math.max(1, seconds / 9.35);
    assert.ok(speed <= 1.19, "Unnatural tempo needed; revise the narration");
    const filter = "aresample=48000,atempo=" + speed.toFixed(5) +
      ",adelay=140,afade=t=in:st=0.14:d=0.12," +
      "apad=whole_dur=10,atrim=duration=10";
    execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", wav, "-af", filter, "-ac", "1", "-ar", "48000",
      "-c:a", "pcm_s16le", ready], 120000);
    assert.ok(Math.abs(Number(metadata(ready).format.duration) - 10) < 0.05);
    padded.push(ready);
    receipts.push({beat: beat.id, text: beat.narration, sourceSeconds: seconds,
      tempo: Number(speed.toFixed(5))});
  }
  const audio = join(root, "approved-private-voice-minute.wav");
  const filter = padded.map((_, i) => "[" + i +
    ":a]aresample=48000,asetpts=PTS-STARTPTS[a" + i + "]").join(";") +
    ";" + padded.map((_, i) => "[a" + i + "]").join("") +
    "concat=n=6:v=0:a=1[out]";
  execute("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...padded.flatMap(file => ["-i", file]),
    "-filter_complex", filter, "-map", "[out]",
    "-c:a", "pcm_s16le", "-ac", "1", "-ar", "48000", audio,
  ], 180000);
  assert.ok(Math.abs(Number(metadata(audio).format.duration) - SECONDS) < 0.1);
  return {audio, receipts};
}

async function privateRoot() {
  await mkdir(PARENT, {recursive: true, mode: 0o700});
  const info = await lstat(PARENT);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(await realpath(PARENT), PARENT);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o077, 0);
  const disk = await statfs(PARENT);
  assert.ok(disk.bavail * disk.bsize >= 2 * 1024 ** 3,
    "At least 2 GiB free space required for safe temporary video rendering");
}

async function renderPrivate(story, catalog) {
  assert.ok(process.env.CI !== "true" && process.env.GITHUB_ACTIONS !== "true" &&
    process.env.VNS_VPS_PREVIEW_APPROVED === "PRIVATE_REVIEW_ONLY" &&
    typeof process.getuid === "function" && process.getuid() === 1000 &&
    userInfo().username === "ap", "Refused outside explicitly authorized private ap session");
  const manifestPath = process.env.VNS_P3_18_MEDIA_MANIFEST;
  assert.ok(typeof manifestPath === "string" && isAbsolute(manifestPath));
  const info = await lstat(manifestPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() &&
    info.size > 100 && info.size <= MAX_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  requirePilotMediaScope(manifest, catalog);
  const plan = await loadLayeredTimeline({
    manifestPath, beatFrames: Array(6).fill(240),
    beatVisuals: story.beats.map(b => b.visual),
  });
  assert.equal(plan.timelineFrames, FRAMES);
  assert.equal(plan.backgrounds.length, 3);
  assert.equal(plan.foreground.length, 2);
  await privateRoot();
  const root = await mkdtemp(join(tmpdir(), "vns-p3-18-authentic-"));
  const stamp = "p3-18-ozone-real-" + new Date().toISOString()
    .replace(/[-:.]/g, "").replace("T", "-").slice(0, 15) + "-" +
    randomBytes(4).toString("hex");
  try {
    const {audio, receipts} = await synthesizeMinute(story, root);
    const video = join(root, "one-minute-video-only.mp4");
    await encodeLayeredSequence({plan, output: video,
      directory: join(root, "graphic-layers")});
    const movie = join(root, "ozone-2026-minute-private-review.mp4");
    execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-protocol_whitelist", "file,pipe", "-i", video,
      "-protocol_whitelist", "file,pipe", "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
      "-c:a", "aac", "-b:a", "128k",
      "-t", "60", "-movflags", "+faststart", movie,
    ], 180000);
    const out = metadata(movie);
    assert.equal(out.streams.length, 2);
    const videoStream = out.streams.find(s => s.codec_type === "video");
    const audioStream = out.streams.find(s => s.codec_type === "audio");
    assert.equal(videoStream?.codec_name, "h264");
    assert.equal(audioStream?.codec_name, "aac");
    assert.equal(videoStream.width, 1280);
    assert.equal(videoStream.height, 720);
    assert.equal(Number(videoStream.nb_frames), FRAMES);
    assert.ok(Math.abs(Number(out.format.duration) - 60) < 0.14);
    const contacts = [];
    for (const [index, second] of [5, 15, 25, 35, 45, 55].entries()) {
      const name = "review-beat-" + String(index + 1).padStart(2, "0") + ".jpg";
      const frame = join(root, name);
      execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", String(second), "-i", movie, "-frames:v", "1",
        "-q:v", "3", frame], 30000);
      assert.ok((await stat(frame)).size > 5000);
      contacts.push({name, second, sha256: await hash(frame)});
    }
    const report = {
      schemaVersion: 1, status: "REAL_MEDIA_PRIVATE_REVIEW_REQUIRED",
      publicationAllowed: false, humanVisualApproval: false,
      piperCommercialRightsApproved: false,
      editorialStoryApprovedForPublication: false,
      durationSeconds: SECONDS, frames: FRAMES, fps: FPS,
      model: {name: VOICE_FILE, sha256: VOICE_SHA, privateDemonstrationOnly: true},
      narration: receipts,
      video: {name: "ozone-2026-minute-private-review.mp4",
        sha256: await hash(movie)},
      media: manifest.assets.map(asset => ({
        id: asset.id, candidateId: asset.candidateId, kind: asset.kind,
        role: asset.role, sha256: asset.sha256, sourceUrl: asset.sourceUrl,
        credit: asset.credit, licenseUrl: asset.licenseUrl,
        licenseEvidence: asset.licenseEvidence,
        rightsReviewedBy: asset.rightsReviewedBy,
        rightsReviewedAt: asset.rightsReviewedAt,
        reviewReceipt: asset.reviewReceipt,
      })),
      scienceSources: story.sources, contacts,
    };
    // Persist through a hidden, private, non-overwriting staging directory.
    const staging = await mkdtemp(join(PARENT, ".p3-18-staging-"));
    const target = join(PARENT, stamp);
    try {
      const items = [report.video.name, ...contacts.map(c => c.name)];
      for (const name of items)
        await copyFile(join(root, name), join(staging, name), fsConstants.COPYFILE_EXCL);
      await writeFile(join(staging, "review-receipt.json"),
        JSON.stringify(report, null, 2) + "\n", {mode: 0o600, flag: "wx"});
      assert.equal(await hash(join(staging, report.video.name)), report.video.sha256);
      for (const contact of contacts)
        assert.equal(await hash(join(staging, contact.name)), contact.sha256);
      await rename(staging, target);
    } catch (error) {
      await rm(staging, {recursive: true, force: true});
      throw error;
    }
    console.log("P3_18_PRIVATE_FILM=" + join(target, report.video.name));
    console.log("P3_18_PRIVATE_REPORT=" + join(target, "review-receipt.json"));
    console.log("P3_18_VIDEO_SHA256=" + report.video.sha256);
    console.log("P3_18_PUBLICATION=DENIED; NASA/PIPER COMMERCIAL RIGHTS NOT INFERRED");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function main() {
  const mode = process.argv[2];
  assert.ok(process.argv.length === 3 &&
    (mode === "--check-editorial" || mode === "--save-private"),
    "Usage: --check-editorial or --save-private only");
  const {story, catalog, words} = await loadOzonePilot();
  if (mode === "--check-editorial") {
    console.log("P3-18 EDITORIAL 60-SECOND PLAN VALID: " + story.beats.length +
      " narrated beats, " + words + " original English words, zero approved real media");
    return;
  }
  await renderPrivate(story, catalog);
}

const invoked = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) await main();
