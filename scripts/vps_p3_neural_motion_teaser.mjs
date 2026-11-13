#!/usr/bin/env node
/**
 * P3 private 30-45 s neural-voice/motion quality comparison.
 * Uses fixed English source material, original SVG graphics and a locally
 * installed Piper voice model. No provider API, DB, Redis, upload or webroot.
 * This is an editorially unapproved PRIVATE PREVIEW, not a production renderer.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  buildOfflineVideoCreditsReport,
  makeOfflineGraphicStoryboard,
} from "../packages/shared/dist/index.js";

const ci = process.argv.length === 2 &&
  process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true";
const local = process.argv.length === 3 &&
  process.argv[2] === "--save-local" &&
  process.env.GITHUB_ACTIONS !== "true" &&
  process.env.CI !== "true" &&
  process.env.VNS_QUALITY_TEASER_APPROVED === "PRIVATE_REVIEW_ONLY" &&
  typeof process.getuid === "function" &&
  process.getuid() === 1000 && userInfo().username === "ap";

if (!ci && !local) {
  throw new Error("REFUSED: disposable CI proof or explicit private ap preview only");
}
process.umask(0o077);

const STORY = new URL("../content/news/ozone-2026-explained-en.json", import.meta.url);
const VOICE_SHA256 = "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f";
const VOICE_NAME = "en_US-lessac-medium.onnx";
const FPS = 24;
const FADE = 0.55;
const VISUAL_ASSETS = Object.freeze([
  {
    filename: "earth-nasa.jpg",
    sha256: "872e1a5317ac31612a766ef6dfa7e774e2d10509b1e564b38e3aa384d6b0bf19",
    credit: "NASA / Suomi NPP (PIA18033)",
  },
  {
    filename: "ozone-2026-nasa.jpg",
    sha256: "22b83f5dab6248d401e5ac313f98a18626b8c1ca002e43b67209d56f69ce0c6d",
    credit: "NASA Earth Observatory / Lauren Dauphin",
  },
]);
const TEXT = [
  "Antarctica's ozone hole was unusually large in twenty twenty-six.",
  "The seasonal average covered about twenty-five million square kilometres.",
  "That placed it seventh among forty-eight years of observations.",
  "Yet NASA and NOAA still see a long-term recovery.",
  "How can both be true?",
  "Strong, cold polar winds can amplify ozone loss in a single year,",
  "even while the chemicals that damaged the ozone layer slowly decline.",
  "And area isn't the same as depth.",
  "The lowest South Pole reading reached one hundred and five Dobson units.",
  "One extraordinary year doesn't erase decades of progress.",
  "Follow the evidence, not just the headline.",
].join(" ");

function exec(program, args, timeout = 120000) {
  const result = spawnSync(program, args, {
    shell: false,
    timeout,
    encoding: "utf8",
    maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(program + " failed: " +
      (result.error?.code ?? result.status) + " " +
      (result.stderr ?? "").slice(-700));
  }
  return result.stdout;
}

function probe(path) {
  return JSON.parse(exec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_name,codec_type,width,height,nb_frames",
    "-of", "json", path,
  ], 10000));
}

async function prepareVoice() {
  const python = process.env.VNS_PIPER_PYTHON;
  const model = process.env.VNS_PIPER_MODEL;
  assert.ok(typeof python === "string" && isAbsolute(python));
  assert.ok(typeof model === "string" && isAbsolute(model));
  assert.ok(model.endsWith("/" + VOICE_NAME));
  const modelInfo = await lstat(model);
  assert.ok(modelInfo.isFile() && !modelInfo.isSymbolicLink());
  assert.ok(modelInfo.size > 60e6 && modelInfo.size < 66e6);
  const digest = createHash("sha256").update(await readFile(model)).digest("hex");
  assert.equal(digest, VOICE_SHA256, "Piper model digest mismatch");
  const config = JSON.parse(await readFile(model + ".json", "utf8"));
  assert.equal(config.audio.sample_rate, 22050);
  assert.equal(config.language.code, "en_US");
  exec(python, ["-m", "piper", "--help"], 15000);
  return { python, model };
}

async function prepareVisualAssets() {
  const root = process.env.VNS_VISUAL_ASSETS_DIR;
  assert.ok(typeof root === "string" && isAbsolute(root));
  const rootInfo = await lstat(root);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
  const images = [];
  for (const asset of VISUAL_ASSETS) {
    const path = join(root, asset.filename);
    const details = await lstat(path);
    assert.ok(details.isFile() && !details.isSymbolicLink());
    assert.ok(details.size > 25000 && details.size < 12 * 1024 * 1024);
    const raw = await readFile(path);
    assert.equal(raw.subarray(0, 3).toString("hex"), "ffd8ff", "NASA photo must be JPEG");
    assert.equal(
      createHash("sha256").update(raw).digest("hex"),
      asset.sha256,
      "NASA image digest mismatch: " + asset.filename,
    );
    const info = probe(path);
    const video = info.streams.find((stream) => stream.codec_type === "video");
    assert.ok(video?.width >= 700 && video?.height >= 480,
      "Photo resolution is too small: " + asset.filename);
    images.push(path);
  }
  return images;
}

function graphics(story) {
  assert.equal(story.id, "ozone-2026-explained-en");
  assert.equal(story.language, "en-US");
  assert.equal(story.asOf, "2026-11-09");
  assert.equal(story.editorialStatus, "REVIEW_REQUIRED");
  for (const gate of [
    "editorialApproved", "rightsApproved", "renderAllowed",
    "uploadAllowed", "publicationAllowed",
  ]) {
    assert.equal(story[gate], false);
  }
  const byId = new Map(story.sections.map((section) => [section.id, section]));
  const urls = new Map(story.sources.map((source) => [source.id, source.url]));
  assert.ok(story.sources.length >= 4);
  const choices = [
    ["hook", 0],
    ["what-happened", 0],
    ["what-happened", 1],
    ["why-is-it-happening", 1],
    ["takeaway", 0],
  ];
  const scenes = choices.map(([id, index]) => {
    const section = byId.get(id);
    assert.ok(section);
    const visual = section.visuals[index];
    assert.ok(visual);
    const sourceUrls = section.sourceIds.slice(0, 3).map((source) => {
      const url = urls.get(source);
      assert.ok(url);
      const parsed = new URL(url);
      assert.equal(parsed.protocol, "https:");
      assert.equal(parsed.username, "");
      assert.equal(parsed.password, "");
      return url;
    });
    return { ...visual, sourceUrls };
  });
  const rights = buildOfflineVideoCreditsReport({
    videoId: "00000000-0000-4000-8000-000000000481",
    assets: [],
  });
  assert.equal(rights.status, "BLOCKED");
  assert.equal(rights.renderAllowed, false);
  assert.equal(rights.uploadAllowed, false);
  const result = makeOfflineGraphicStoryboard({
    storyId: "00000000-0000-4000-8000-000000000480",
    language: "en-US",
    scenes,
  });
  assert.equal(result.status, "PREVIEW_ONLY", JSON.stringify(result.errors));
  assert.equal(result.frames.length, 5);
  assert.equal(result.videoRenderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  assert.equal(result.sourcesVerified, false);
  return result.frames;
}

async function makeVideo(frames, wav, dir, seconds, images) {
  const totalFrames = Math.ceil(seconds * FPS);
  const sceneFrames = Math.ceil((totalFrames + 4 * FADE * FPS) / 5);
  const sceneSeconds = sceneFrames / FPS;
  const pngFiles = [];
  let chartSceneIndex = -1;
  let chartOverlay = null;
  for (const [index, frame] of frames.entries()) {
    assert.match(frame.svg, /PREVIEW – NOT FOR PUBLICATION/);
    assert.doesNotMatch(frame.svg, /<image\b|<script\b|<foreignObject\b|xlink:href\b/);
    let svgText = frame.svg;
    if (frame.kind === "chart") {
      assert.equal(chartSceneIndex, -1, "Exactly one animated chart expected");
      chartSceneIndex = index;
      const bars = [];
      // Split the original bar shapes into a separately animated transparent
      // layer. All titles, labels and source text remain a fixed 1280x720 image.
      svgText = svgText.replace(
        /<rect x="460" y="(\d+)" width="(\d+)" height="35" rx="5" fill="#64d8cb"\/>/g,
        (_whole, y, width) => {
          bars.push({ y: Number(y) - 215, width: Number(width) });
          return "";
        },
      );
      assert.equal(bars.length, 2);
      assert.ok(bars.every(({ y, width }) =>
        y >= 0 && y <= 135 && width > 0 && width <= 650));
      const layer = '<svg xmlns="http://www.w3.org/2000/svg" ' +
        'width="650" height="170" viewBox="0 0 650 170">' +
        bars.map(({ y, width }) =>
          '<rect x="0" y="' + y + '" width="' + width +
          '" height="35" rx="5" fill="#64d8cb"/>').join("") +
        "</svg>";
      const barSvg = join(dir, "chart-bars.svg");
      chartOverlay = join(dir, "chart-bars.png");
      await writeFile(barSvg, layer, { mode: 0o600, flag: "wx" });
      exec("rsvg-convert", ["--output", chartOverlay, barSvg], 30000);
      assert.equal((await readFile(chartOverlay)).subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a");
    }
    // Render a transparent news-style foreground over genuine NASA imagery.
    // Never animate or resample text: the final 1280x720 composite is static.
    const oldBackground = '<rect x="0" y="0" width="1280" height="720" fill="#0a1929"/>';
    assert.ok(svgText.includes(oldBackground));
    svgText = svgText.replace(oldBackground,
      '<rect x="0" y="0" width="1280" height="720" fill="#071420" fill-opacity="0.76"/>');
    const showInset = index === 0 || index === 4;
    if (showInset) {
      svgText = svgText.replace("</svg>",
        '<rect x="828" y="378" width="344" height="250" rx="9" ' +
        'fill="#0a1b29" stroke="#64d8cb" stroke-width="3"/>' +
        '<text x="841" y="646" font-size="17" fill="#c9e1f0" ' +
        'font-family="Arial, sans-serif">NASA EO / Lauren Dauphin · 2026 data</text></svg>');
    }
    const path = join(dir, "graphic-" + index + ".svg");
    const transparent = join(dir, "foreground-" + index + ".png");
    const png = join(dir, "graphic-" + index + ".png");
    await writeFile(path, svgText, { mode: 0o600, flag: "wx" });
    exec("rsvg-convert", ["--output", transparent, path], 30000);
    const source = images[index % 2];
    const filters = [
      "[0:v]scale=1280:720:force_original_aspect_ratio=increase," +
        "crop=1280:720,eq=brightness=-0.08:saturation=0.78[photo]",
      "[photo][1:v]overlay=0:0:format=auto[headlines]",
    ];
    if (showInset) {
      filters.push("[2:v]scale=316:224:force_original_aspect_ratio=decrease," +
        "pad=316:224:(ow-iw)/2:(oh-ih)/2:color=0x101d29[inset]");
      filters.push("[headlines][inset]overlay=842:389:format=auto[final]");
    }
    exec("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", source, "-i", transparent,
      ...(showInset ? ["-i", images[1]] : []),
      "-filter_complex", filters.join(";"),
      "-map", showInset ? "[final]" : "[headlines]",
      "-frames:v", "1", png,
    ], 60000);
    assert.equal((await readFile(png)).subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a");
    pngFiles.push(png);
  }
  assert.ok(chartOverlay !== null && chartSceneIndex >= 0);
  const inputArgs = [...pngFiles, chartOverlay].flatMap((png) => [
    "-protocol_whitelist", "file,pipe",
    "-loop", "1", "-framerate", String(FPS),
    "-t", sceneSeconds.toFixed(6), "-i", png,
  ]);
  const chains = [];
  for (let index = 0; index < pngFiles.length; index++) {
    chains.push("[" + index + ":v]format=yuv420p[fixed" + index + "]");
    let base = "fixed" + index;
    if (index === chartSceneIndex) {
      chains.push("[" + pngFiles.length +
        ":v]format=rgba,scale=w='max(2,trunc(650*min(t/2,1)/2)*2)'" +
        ":h=170:eval=frame[animatedbars]");
      chains.push("[" + base +
        "][animatedbars]overlay=x=460:y=215:eval=frame:shortest=1" +
        ":format=auto,format=yuv420p[chartwithbars]");
      base = "chartwithbars";
    }
    // Animate only an isolated decorative underline above the infographic.
    // Never zoom, translate or resample the completed SVG with text.
    chains.push("color=c=0x64d8cb:s=420x6:r=" + FPS +
      ":d=" + sceneSeconds.toFixed(6) +
      ",format=rgba[accent" + index + "]");
    chains.push("[" + base + "][accent" + index +
      "]overlay=x='-420+512*min(t/1.4,1)':y=174" +
      ":eval=frame:shortest=1:format=auto,format=yuv420p[v" + index + "]");
  }
  let previous = "v0";
  for (let index = 1; index < pngFiles.length; index++) {
    const dest = index === pngFiles.length - 1 ? "outv" : "mix" + index;
    const offset = (index * (sceneFrames / FPS - FADE)).toFixed(6);
    chains.push("[" + previous + "][v" + index +
      "]xfade=transition=fade:duration=" + FADE +
      ":offset=" + offset + "[" + dest + "]");
    previous = dest;
  }
  const movie = join(dir, "NEURAL_MOTION_PREVIEW_NOT_PUBLISHABLE.mp4");
  exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    ...inputArgs,
    "-protocol_whitelist", "file,pipe", "-i", wav,
    "-filter_complex", chains.join(";"),
    "-map", "[outv]", "-map", (pngFiles.length + 1) + ":a:0",
    "-t", seconds.toFixed(6),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
    "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "1",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-movflags", "+faststart",
    "-metadata", "title=ENGLISH PRIVATE NEURAL MOTION TEASER - REVIEW REQUIRED",
    movie,
  ], 480000);
  const info = probe(movie);
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  assert.equal(video?.codec_name, "h264");
  assert.equal(video?.width, 1280);
  assert.equal(video?.height, 720);
  assert.equal(audio?.codec_name, "aac");
  assert.ok(Math.abs(Number(info.format.duration) - seconds) <= 0.3);
  assert.ok(Number(info.format.duration) >= 30 && Number(info.format.duration) <= 45);
  assert.ok(Number(info.format.size) > 100000 && Number(info.format.size) < 40e6);
  // Regression: two decoded frames of the first headline must have identical
  // typography pixels. Previous whole-frame zoompan visibly made text shimmer.
  const stableText = exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", movie,
    "-vf", "crop=900:80:92:65,select='eq(n,48)+eq(n,60)'",
    "-fps_mode", "vfr", "-f", "framemd5", "-",
  ], 30000);
  const hashes = stableText.split("\n")
    .filter((line) => /^0,/.test(line.trim()))
    .map((line) => line.split(",").at(-1).trim());
  assert.equal(hashes.length, 2, "Must sample exactly two stable-text frames");
  assert.equal(hashes[0], hashes[1], "Static title text must not jitter across frames");
  console.log("STATIC_TEXT_PIXEL_STABILITY=PASS");
  // The isolated chart bars, unlike text, must genuinely change over time.
  const chartOffset = chartSceneIndex * (sceneFrames / FPS - FADE);
  const first = Math.round((chartOffset + 0.75) * FPS);
  const second = Math.round((chartOffset + 1.65) * FPS);
  const animatedChart = exec("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", movie,
    "-vf", "crop=650:135:460:215,select='eq(n," + first +
      ")+eq(n," + second + ")'",
    "-fps_mode", "vfr", "-f", "framemd5", "-",
  ], 30000);
  const barHashes = animatedChart.split("\n")
    .filter((line) => /^0,/.test(line.trim()))
    .map((line) => line.split(",").at(-1).trim());
  assert.equal(barHashes.length, 2, "Must sample two animated chart frames");
  assert.notEqual(barHashes[0], barHashes[1], "Chart bars must animate independently");
  console.log("INDEPENDENT_CHART_ANIMATION=PASS");
  return { movie, duration: Number(info.format.duration) };
}

async function savePrivate(movie) {
  const root = "/home/ap/videonews-previews";
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o077, 0);
  assert.equal(await realpath(root), root);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
  const name = "english-neural-motion-teaser-" + stamp + "-" + randomBytes(4).toString("hex");
  const partial = join(root, "." + name + ".partial");
  const target = join(root, name + ".mp4");
  try {
    await copyFile(movie, partial, fsConstants.COPYFILE_EXCL);
    await chmod(partial, 0o600);
    await rename(partial, target);
  } finally {
    await rm(partial, { force: true });
  }
  console.log("VNS_PRIVATE_QUALITY_PREVIEW_PATH=" + target);
}

async function main() {
  const story = JSON.parse(await readFile(STORY, "utf8"));
  const frames = graphics(story);
  const { python, model } = await prepareVoice();
  const images = await prepareVisualAssets();
  exec("ffmpeg", ["-version"], 10000);
  exec("rsvg-convert", ["--version"], 10000);
  const dir = await mkdtemp(join(tmpdir(), "vns-p3-neural-teaser-"));
  try {
    const input = join(dir, "original-english-teaser.txt");
    const wav = join(dir, "neural-voice.wav");
    await writeFile(input, TEXT, { mode: 0o600, flag: "wx" });
    exec(python, [
      "-m", "piper", "-m", model,
      "--length-scale", "0.91",
      "--sentence-silence", "0.13",
      "--input-file", input,
      "-f", wav,
    ], 180000);
    const speech = probe(wav);
    const seconds = Number(speech.format.duration);
    assert.ok(Number.isFinite(seconds) && seconds >= 30 && seconds <= 45,
      "Natural narration must be 30-45 seconds without silence padding: " + seconds);
    const result = await makeVideo(frames, wav, dir, seconds, images);
    const bytes = await readFile(result.movie);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    console.log("P3 NEURAL MOTION QUALITY PASS: " + result.duration.toFixed(3) +
      " seconds; " + frames.length + " scenes with isolated moving graphics; " +
      "H264/AAC; bytes=" + bytes.length + "; SHA256=" + sha256);
    console.log("Piper en_US-lessac-medium (verified ONNX); private preview only.");
    console.log("NASA source imagery (two checked images) + dark overlay + labeled insets.");
    console.log("Editorial approval: DENIED. Upload/publication: NOT ENABLED.");
    if (local) await savePrivate(result.movie);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
