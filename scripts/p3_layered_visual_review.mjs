#!/usr/bin/env node
/**
 * P3-17 private layered full-bleed visual-quality witness.
 *
 * Creates three ORIGINAL, SYNTHETIC moving sources with burned-in timestamps,
 * legends and scales, then renders two full-bleed backdrops with real 12-frame
 * xfade crossfade, five independent cinematic beats and a science-video inset.
 * CI destroys every file; on the VPS only a manual ap-only opt-in may persist
 * a private MP4, contact images and provenance receipt outside the webroot.
 *
 * No NASA material, provider API, Piper voice, production worker or upload.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {constants as fsConstants} from "node:fs";
import {copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir, userInfo} from "node:os";
import {join} from "node:path";
import {encodeLayeredSequence, planLayeredTimeline} from "./p3_layered_cinematic_composition.mjs";

const FPS = 24;
const FRAME_COUNT = 240;
const PRIVATE_ROOT = "/home/ap/videonews-previews";
const PRIVATE_NAME = "p3-17-layered-visual-review";
const CI_ONLY = process.argv.length === 3 && process.argv[2] === "--verify-ephemeral";
const SAVE_PRIVATE = process.argv.length === 3 &&
  process.argv[2] === "--save-private" &&
  process.env.CI !== "true" &&
  process.env.GITHUB_ACTIONS !== "true" &&
  process.env.VNS_VPS_PREVIEW_APPROVED === "PRIVATE_REVIEW_ONLY" &&
  typeof process.getuid === "function" &&
  process.getuid() === 1000 &&
  userInfo().username === "ap";

if (!CI_ONLY && !SAVE_PRIVATE) {
  throw new Error("REFUSED: only ephemeral synthetic proof or explicit ap-only private review");
}
process.umask(0o077);

function run(name, args, timeout = 180000) {
  const p = spawnSync(name, args, {
    shell: false, encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  if (p.error || p.status !== 0) throw new Error(
    "VISUAL_REVIEW_COMMAND_FAILED " + name + " status=" + p.status +
    " error=" + (p.error?.code ?? "none") +
    " stderr=" + (p.stderr ?? "").slice(-1200));
  return p.stdout;
}

async function sha(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function svgEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Original fake science-looking background; deliberately NOT observed data. */
function syntheticBackgroundSvg(index) {
  const purple = index === 1;
  const colors = purple
    ? {a: "#102246", b: "#235b89", c: "#76b4bb", d: "#9d6fb2"}
    : {a: "#102a43", b: "#18647c", c: "#86c2b2", d: "#d89e61"};
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<defs><radialGradient id="field"><stop offset="0" stop-color="' + colors.d +
      '"/><stop offset=".48" stop-color="' + colors.c +
      '"/><stop offset=".78" stop-color="' + colors.b +
      '"/><stop offset="1" stop-color="' + colors.a + '"/></radialGradient></defs>',
    '<rect width="1280" height="720" fill="' + colors.a + '"/>',
    '<ellipse cx="640" cy="360" rx="420" ry="348" fill="url(#field)"/>',
    '<g fill="none" stroke="#ffffff" stroke-opacity=".28" stroke-width="3">',
    '<ellipse cx="640" cy="360" rx="170" ry="140"/>',
    '<ellipse cx="640" cy="360" rx="280" ry="230"/>',
    '<ellipse cx="640" cy="360" rx="388" ry="316"/>',
    '<path d="M250 360 H1030 M640 30 V690 M350 190 Q640 540 930 190 M350 520 Q640 170 930 520"/>',
    '</g>',
    '<g fill="none" stroke="' + (purple ? "#90e1f2" : "#ffd6a1") +
      '" stroke-opacity=".72" stroke-width="18" stroke-linecap="round">',
    purple ? '<path d="M350 440 Q450 100 700 190 T970 385"/>'
      : '<path d="M355 370 Q465 165 650 285 T920 400"/>',
    '</g></svg>',
  ].join("");
}

/** Labels deliberately burned INTO the synthetic source, NOT the side rail. */
function syntheticAnnotationsSvg(index) {
  const text = index === 1 ? "SIMULATED ALTITUDE FIELD" : "SIMULATED POLAR FIELD";
  const swatches = ["#1b3c8e", "#2e8cc9", "#87c9bd", "#e1cd70", "#dd8553"];
  const rows = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<rect x="15" y="15" width="570" height="76" rx="12" fill="#071420" fill-opacity=".89"/>',
    '<text x="32" y="61" fill="#ffffff" font-family="DejaVu Sans" font-weight="bold" font-size="31">' +
      svgEscape(text) + '</text>',
    '<rect x="804" y="15" width="460" height="76" rx="12" fill="#071420" fill-opacity=".89"/>',
    '<text x="822" y="60" fill="#ffffff" font-family="DejaVu Sans" font-size="29">' +
      "SYNTHETIC DATE: 2026-11-13" + '</text>',
    '<rect x="15" y="628" width="535" height="78" rx="12" fill="#071420" fill-opacity=".90"/>',
    '<text x="31" y="678" fill="#ffffff" font-family="DejaVu Sans" font-size="27">' +
      "NO OBSERVATIONAL DATA" + '</text>',
    '<rect x="727" y="608" width="538" height="98" rx="12" fill="#071420" fill-opacity=".91"/>',
    '<text x="745" y="641" fill="#ffffff" font-family="DejaVu Sans" font-size="24">' +
      "ILLUSTRATIVE COLOR SCALE" + '</text>',
  ];
  swatches.forEach((color, i) => rows.push(
    '<rect x="' + (745 + 100 * i) +
    '" y="658" width="97" height="27" fill="' + color + '"/>'));
  rows.push("</svg>");
  return rows.join("");
}

async function syntheticSource(root, index, seconds) {
  const bgSvg = join(root, "background-" + index + ".svg");
  const bgPng = join(root, "background-" + index + ".png");
  const noteSvg = join(root, "annotations-" + index + ".svg");
  const notePng = join(root, "annotations-" + index + ".png");
  const video = join(root, "synthetic-source-" + index + ".mp4");
  await writeFile(bgSvg, syntheticBackgroundSvg(index), {flag: "wx", mode: 0o600});
  await writeFile(noteSvg, syntheticAnnotationsSvg(index), {flag: "wx", mode: 0o600});
  run("rsvg-convert", ["--output", bgPng, bgSvg]);
  run("rsvg-convert", ["--output", notePng, noteSvg]);
  // The animated polar field moves slightly, while the source's own date,
  // legend and scale remain fixed inside its source video pixels.
  const motion = index === 1 ? "0.00055" : "0.0008";
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-loop", "1", "-framerate", "24", "-i", bgPng,
    "-loop", "1", "-framerate", "24", "-i", notePng,
    "-f", "lavfi", "-i", "sine=frequency=" + (index === 1 ? 730 : 950) +
      ":sample_rate=48000",
    "-filter_complex",
    "[0:v]zoompan=z='min(zoom+" + motion +
      ",1.08)':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=1280x720:fps=24[move];" +
      "[move][1:v]overlay=0:0:shortest=1,format=yuv420p[outv]",
    "-map", "[outv]", "-map", "2:a:0", "-t", String(seconds),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
    "-threads:v", "1", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k", video,
  ], 180000);
  return video;
}

function probe(file) {
  return JSON.parse(run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_name,codec_type,nb_frames,width,height",
    "-of", "json", file,
  ]));
}

async function screenshot(video, destination, time) {
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-ss", String(time), "-i", video,
    "-frames:v", "1", "-q:v", "3", destination,
  ], 30000);
  assert.ok((await stat(destination)).size > 3000, "Missing review contact frame");
}

async function preview(root) {
  const sourceA = await syntheticSource(root, 0, 7);
  const sourceB = await syntheticSource(root, 1, 7);
  const sourceInset = await syntheticSource(root, 2, 3);
  const sources = [sourceA, sourceB, sourceInset];
  const assets = [];
  for (let i = 0; i < sources.length; i++) {
    assets.push({
      id: "CI_SYNTHETIC_" + (i + 1), motifId: "CI_SYNTHETIC_MOTIF_" + (i + 1),
      kind: "video", path: sources[i], sha256: await sha(sources[i]),
      sceneId: i === 0 ? "beat-01" : i === 1 ? "beat-03" : "beat-02",
      endSceneId: i === 0 ? "beat-02" : i === 1 ? "beat-05" : "beat-02",
      role: i === 2 ? "science-inset" : "background",
      scientificVisualization: i === 2,
      compositionMode: "layered-cinematic",
      sourceUrl: "https://example.org/ci-generated-only-" + (i + 1),
      creator: "VideoNewsStudio original synthetic preview",
      credit: "Generated synthetic artwork " + (i + 1) + " / NOT NASA",
      captureDate: "2026-11-13",
      licenseUrl: "https://example.org/ci-synthetic-only",
      licenseEvidence: "Generated by this local script, not externally licensed footage",
      rightsReviewedBy: "CI-fixture-not-real-media",
      rightsReviewedAt: "2026-11-13",
      rightsApproved: true, editorialApproved: true, thirdPartyRightsCleared: true,
    });
  }
  const beatFrames = Array(5).fill(48);
  const visuals = Array.from({length: 5}, (_, index) => ({
    kind: "text-card", title: "Synthetic scene " + (index + 1),
    body: "A synthetic preview, not an actual observation.",
  }));
  visuals[0] = {kind: "text-card", title: "Fullscreen moving atmosphere",
    body: "The image is background, softened by a dark translucent gradient."};
  visuals[1] = {kind: "chart", title: "Scientific image in foreground", bars: [
    {label: "SIMULATED low", value: 24}, {label: "SIMULATED high", value: 73},
  ]};
  visuals[2] = {kind: "text-card", title: "Crossfade to a new backdrop",
    body: "Twelve overlap frames connect both moving sources without a hard cut."};
  visuals[3] = {kind: "text-card", title: "Background continues moving",
    body: "The information changes independently over a dimmed full-screen video."};
  visuals[4] = {kind: "text-card", title: "Closing science perspective",
    body: "The backdrop can be partly concealed while foreground text stays clear."};

  const plan = await planLayeredTimeline({
    manifest: {schemaVersion: 1, assets}, assetRoot: root,
    beatFrames, beatVisuals: visuals,
  });
  assert.equal(plan.backgrounds.length, 2);
  assert.equal(plan.foreground.length, 1);
  assert.equal(plan.timelineFrames, FRAME_COUNT);
  assert.deepEqual(plan.backgrounds.map(source => source.sourceFrames),
    [102, 150]);
  const joined = join(root, "joined-video-only.mp4");
  await encodeLayeredSequence({
    plan, output: joined, directory: join(root, "layered-graphics"),
  });
  const voice = join(root, "synthetic-continuous-audio.wav");
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "10", "-c:a", "pcm_s16le", voice,
  ]);
  const movie = join(root, "layered-visual-review.mp4");
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", joined, "-i", voice,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart", movie,
  ]);
  const video = probe(movie);
  assert.equal(video.streams.length, 2);
  const v = video.streams.find(s => s.codec_type === "video");
  const a = video.streams.find(s => s.codec_type === "audio");
  assert.ok(v && a);
  assert.equal(v.codec_name, "h264");
  assert.equal(a.codec_name, "aac");
  assert.equal(v.width, 1280);
  assert.equal(v.height, 720);
  assert.equal(Number(v.nb_frames), FRAME_COUNT);
  assert.ok(Math.abs(Number(video.format.duration) - 10) < 0.15);

  const contacts = [];
  for (const [i, time] of [1, 3, 5, 7, 9].entries()) {
    const file = join(root, "review-frame-" + String(i + 1).padStart(2, "0") + ".jpg");
    await screenshot(movie, file, time);
    contacts.push({name: file.split("/").at(-1), timeSeconds: time, sha256: await sha(file)});
  }
  return {
    movie,
    contacts,
    report: {
      schemaVersion: 1,
      status: "PRIVATE_SYNTHETIC_VISUAL_REVIEW_ONLY",
      publicationAllowed: false,
      actualNasaMediaUsed: false,
      actualPiperVoiceUsed: false,
      syntheticFixtureRightsOnly: true,
      fps: FPS,
      frames: FRAME_COUNT,
      seconds: 10,
      renderedBeats: ["beat-01", "beat-02", "beat-03", "beat-04", "beat-05"],
      backgroundCrossfadeFrames: 12,
      backgrounds: 2,
      scienceInsets: 1,
      sourceAssets: assets.map(asset => ({
        id: asset.id, sha256: asset.sha256,
        motifId: asset.motifId, role: asset.role, compositionMode: asset.compositionMode,
      })),
      export: {name: "layered-visual-review.mp4", sha256: await sha(movie)},
      contacts,
      humanVisualApproval: false,
    },
  };
}

async function persistPrivate({contacts, report}, sourceDir) {
  await mkdir(PRIVATE_ROOT, {recursive: true, mode: 0o700});
  const parent = await lstat(PRIVATE_ROOT);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
  assert.equal(await realpath(PRIVATE_ROOT), PRIVATE_ROOT);
  assert.equal(parent.uid, process.getuid(), "Private directory must belong to ap");
  assert.equal(parent.mode & 0o077, 0, "Private directory is accessible to others");

  const outputDir = join(PRIVATE_ROOT, PRIVATE_NAME);
  await mkdir(outputDir, {mode: 0o700}); // refuses existing previews; never overwrite
  for (const name of [report.export.name, ...contacts.map(c => c.name)]) {
    await copyFile(join(sourceDir, name), join(outputDir, name), fsConstants.COPYFILE_EXCL);
  }
  const receipt = join(outputDir, "review-receipt.json");
  await writeFile(receipt, JSON.stringify(report, null, 2) + "\n",
    {mode: 0o600, flag: "wx"});
  assert.equal(await sha(join(outputDir, report.export.name)), report.export.sha256);
  for (const item of contacts)
    assert.equal(await sha(join(outputDir, item.name)), item.sha256);
  console.log("PRIVATE_SYNTHETIC_REVIEW_PATH=" + join(outputDir, report.export.name));
  console.log("PRIVATE_SYNTHETIC_REVIEW_RECEIPT=" + receipt);
}

const root = await mkdtemp(join(tmpdir(), "vns-p3-17-layered-review-"));
try {
  const result = await preview(root);
  if (SAVE_PRIVATE) await persistPrivate(result, root);
  console.log("P3-17 LAYERED VISUAL REVIEW SYNTHETIC PASS: " +
    result.report.frames + " frames; SHA256=" + result.report.export.sha256);
} finally {
  await rm(root, {recursive: true, force: true});
}
