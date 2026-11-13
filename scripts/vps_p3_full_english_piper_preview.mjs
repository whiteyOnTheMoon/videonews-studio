#!/usr/bin/env node
/**
 * English Earth & Climate Explained manually authorized VPS-only review preview.
 * Full seven-part English 8-10 min original explained story.
 * Locally verified NASA background photos, Piper neural narration and original
 * P3 SVG scene graphics. No live feed, provider API, upload or publication.
 * CI verifies narration and all 19 graphic beats; actual MP4 stays on VPS.
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
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  assertEarthClimateExplainedStructure,
  EARTH_CLIMATE_EXPLAINED_SECTION_IDS,
  buildNarrationTimeline,
  buildOfflineVideoCreditsReport,
  makeOfflineGraphicStoryboard,
} from "../packages/shared/dist/index.js";

const CI_AUDIO_ONLY =
  process.argv.length === 3 &&
  process.argv[2] === "--verify-audio-only" &&
  process.env.CI === "true" &&
  process.env.GITHUB_ACTIONS === "true";
const LOCAL_PREVIEW =
  process.argv.length === 3 &&
  process.argv[2] === "--save-local" &&
  process.env.CI !== "true" &&
  process.env.GITHUB_ACTIONS !== "true" &&
  process.env.VNS_VPS_PREVIEW_APPROVED === "PRIVATE_REVIEW_ONLY" &&
  typeof process.getuid === "function" &&
  process.getuid() === 1000 &&
  userInfo().username === "ap";
if (!CI_AUDIO_ONLY && !LOCAL_PREVIEW) {
  throw new Error("REFUSED: explicit ap-only private MP4 or disposable CI audio proof");
}
process.umask(0o077);

const STORY_PATH = new URL("../content/news/ozone-2026-explained-en.json", import.meta.url);
const STORY_ID = "00000000-0000-4000-8000-000000000480";
const VIDEO_ID = "00000000-0000-4000-8000-000000000481";
const FPS = 24;
const PIPER_LENGTH_SCALE = "1.04";
const PIPER_SENTENCE_SILENCE = "0.38";
const VOICE_SHA256 = "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f";
const VOICE_NAME = "en_US-lessac-medium.onnx";
const FPS = 24;
const FADE = 0.55;
// Calm English voice: longer vowels/syllables and natural sentence breaks.
const VOICE_LENGTH_SCALE = "1.04";
const VOICE_SENTENCE_SILENCE = "0.38";
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

const SOURCE_HOSTS = Object.freeze({
  "noaa-2026": "www.noaa.gov",
  "nasa-2026": "science.nasa.gov",
  "cams-2026": "atmosphere.copernicus.eu",
  "dlr-2026": "www.dlr.de",
  "epa-science": "www.epa.gov",
  "unep-facts": "ozone.unep.org",
});

function command(name, args, timeout = 120000) {
  const result = spawnSync(name, args, {
    shell: false,
    encoding: "utf8",
    timeout,
    maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      name +
        " failed: " +
        (result.error?.code ?? result.status) +
        " " +
        (result.stderr ?? "").slice(-900),
    );
  }
  return result.stdout;
}

function probe(path) {
  return JSON.parse(
    command(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,codec_type,width,height,nb_frames,sample_rate,channels",
        "-of",
        "json",
        path,
      ],
      10000,
    ),
  );
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
  command(python, ["-m", "piper", "--help"], 15000);
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

function validateStory(story) {
  assert.equal(story.schemaVersion, 1);
  assert.equal(story.id, "ozone-2026-explained-en");
  assert.equal(story.asOf, "2026-11-09");
  assert.equal(story.editorialStatus, "REVIEW_REQUIRED");
  assert.equal(story.sourceStatus, "manually_curated_public_reports_not_live_ingestion");
  for (const field of [
    "editorialApproved",
    "rightsApproved",
    "renderAllowed",
    "uploadAllowed",
    "publicationAllowed",
  ]) {
    assert.equal(story[field], false, "Never bypass publication gate: " + field);
  }
  assertEarthClimateExplainedStructure(story);
  assert.deepEqual(
    story.sections.map((section) => section.id),
    EARTH_CLIMATE_EXPLAINED_SECTION_IDS,
  );
  assert.equal(story.sources.length, Object.keys(SOURCE_HOSTS).length);
  const sources = new Map();
  for (const source of story.sources) {
    const host = SOURCE_HOSTS[source.id];
    assert.ok(host && !sources.has(source.id));
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, host);
    assert.equal(url.username, "");
    assert.equal(url.password, "");
    assert.equal(url.port, "");
    assert.equal(url.hash, "");
    assert.equal(url.search, "");
    assert.ok(typeof source.evidenceGroup === "string" && source.evidenceGroup.length > 3);
    sources.set(source.id, source);
  }
  assert.equal(sources.get("nasa-2026").evidenceGroup, sources.get("noaa-2026").evidenceGroup);
  assert.notEqual(sources.get("cams-2026").evidenceGroup, sources.get("noaa-2026").evidenceGroup);
  const totalWords = story.sections.reduce((sum, section) => {
    assert.ok(section.sourceIds.length >= 1 && section.sourceIds.length <= 4);
    assert.equal(new Set(section.sourceIds).size, section.sourceIds.length);
    assert.ok(section.sourceIds.every((id) => sources.has(id)));
    assert.ok(
      Array.isArray(section.visuals) && section.visuals.length >= 2 && section.visuals.length <= 4,
    );
    assert.ok(section.visuals.every((visual) => visual && typeof visual.kind === "string"));
    assert.ok(!/[<>]/.test(section.narration) && !/[\r\n]/.test(section.narration));
    return sum + (section.narration.match(/[\w'-]+/g) ?? []).length;
  }, 0);
  assert.ok(
    totalWords >= 1150 && totalWords <= 1550,
    "English narration wordcount out of editorial pilot bounds",
  );
  return { sources, totalWords };
}

async function synthesizeSections(story, directory) {
  const paths = [];
  const timings = [];
  for (const [index, section] of story.sections.entries()) {
    const input = join(directory, "section-" + index + ".txt");
    const path = join(directory, "speech-" + index + ".wav");
    await writeFile(input, section.narration, { mode: 0o600, flag: "wx" });
    command("node", ["--version"], 10000);
    command(process.env.VNS_PIPER_PYTHON, [
      "-m", "piper",
      "-m", process.env.VNS_PIPER_MODEL,
      "--length-scale", PIPER_LENGTH_SCALE,
      "--sentence-silence", PIPER_SENTENCE_SILENCE,
      "--input-file", input,
      "-f", path,
    ], 180000);
    const details = probe(path);
    const stream = details.streams.find((value) => value.codec_type === "audio");
    assert.equal(stream?.codec_name, "pcm_s16le");
    assert.equal(stream?.channels, 1);
    const seconds = Number(details.format.duration);
    assert.ok(Number.isFinite(seconds) && seconds > 4 && seconds < 240);
    paths.push(path);
    timings.push({
      sectionId: section.id,
      audioSeconds: seconds,
      beatCount: section.visuals.length,
    });
  }
  const plan = buildNarrationTimeline(timings, 0.6);
  assert.ok(plan.totalSeconds >= 480 && plan.totalSeconds <= 600,
    "Full script and calmer Piper voice must produce 8-10 minutes, measured " +
      plan.totalSeconds.toFixed(3) + " seconds");
  return { paths, plan };
}

async function prepareBackgrounds(images, directory) {
  const photos = [];
  for (const [index, photo] of images.entries()) {
    const target = join(directory, "background-" + index + ".png");
    command("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", photo,
      "-vf", "scale=1280:720:force_original_aspect_ratio=increase," +
        "crop=1280:720,eq=brightness=-0.08:saturation=0.78",
      "-frames:v", "1", target,
    ], 120000);
    photos.push(target);
  }
  return photos;
}

async function renderGraphics(story, sources, images, directory) {
  const pngPaths = [];
  const backgrounds = await prepareBackgrounds(images, directory);
  const insets = new Set([0, 7, 17]);
  for (const section of story.sections) {
    const sourceUrls = section.sourceIds.slice(0, 3).map((id) => sources.get(id).url);
    for (const visual of section.visuals) {
      const result = makeOfflineGraphicStoryboard({
        storyId: STORY_ID,
        language: "en-US",
        scenes: [{ ...visual, sourceUrls }],
      });
      assert.equal(result.status, "PREVIEW_ONLY", JSON.stringify(result.errors));
      assert.equal(result.frames.length, 1);
      assert.equal(result.videoRenderAllowed, false);
      assert.equal(result.uploadAllowed, false);
      assert.equal(result.sourcesVerified, false);
      const index = pngPaths.length;
      let svg = result.frames[0].svg;
      assert.match(svg, /PREVIEW – NOT FOR PUBLICATION/);
      assert.doesNotMatch(svg, /VORSCHAU|Quellenlinks|<image\b|<script\b|<foreignObject\b/);
      const opaque = '<rect x="0" y="0" width="1280" height="720" fill="#0a1929"/>';
      assert.ok(svg.includes(opaque));
      svg = svg.replace(opaque,
        '<rect x="0" y="0" width="1280" height="720" ' +
        'fill="#071420" fill-opacity="0.76"/>');
      const credit = index % 2 === 0
        ? "NASA / Suomi NPP · Earth composite"
        : "NASA Earth Observatory / Lauren Dauphin · Oct 4, 2026";
      svg = svg.replace("</svg>",
        '<text x="92" y="650" font-size="15" fill="#c9dbe7" ' +
        'font-family="Arial, sans-serif">' + credit + '</text></svg>');
      const inset = insets.has(index);
      if (inset) {
        assert.equal(visual.kind, "text-card");
        svg = svg.replace("</svg>",
          '<rect x="828" y="378" width="344" height="250" rx="9" ' +
          'fill="#0a1b29" stroke="#64d8cb" stroke-width="3"/>' +
          '<text x="841" y="646" font-size="17" fill="#c9e1f0" ' +
          'font-family="Arial, sans-serif">Ozone map: NASA EO · Oct 4, 2026</text></svg>');
      }
      const label = String(index + 1).padStart(2, "0");
      const svgPath = join(directory, "visual-" + label + ".svg");
      const transparent = join(directory, "foreground-" + label + ".png");
      const png = join(directory, "visual-" + label + ".png");
      await writeFile(svgPath, svg, { mode: 0o600, flag: "wx" });
      command("rsvg-convert", ["--output", transparent, svgPath], 30000);
      const filters = [
        "[0:v][1:v]overlay=0:0:format=auto[headlines]",
      ];
      if (inset) {
        filters.push(
          "[2:v]scale=316:224:force_original_aspect_ratio=decrease," +
          "pad=316:224:(ow-iw)/2:(oh-ih)/2:color=0x101d29[inset]",
        );
        filters.push("[headlines][inset]overlay=842:389:format=auto[final]");
      }
      command("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", backgrounds[index % 2],
        "-i", transparent,
        ...(inset ? ["-i", images[1]] : []),
        "-filter_complex", filters.join(";"),
        "-map", inset ? "[final]" : "[headlines]",
        "-frames:v", "1", png,
      ], 120000);
      assert.equal((await readFile(png)).subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a");
      pngPaths.push(png);
    }
  }
  assert.equal(pngPaths.length, 19);
  return pngPaths;
}

async function assembleAudio(speechPaths, plan, directory) {
  const output = join(directory, "one-continuous-narration.wav");
  const filters = plan.sections.map((section, index) => {
    const seconds = (section.frames / FPS).toFixed(9);
    return (
      "[" +
      index +
      ":a]aresample=48000," +
      "aformat=sample_fmts=s16:channel_layouts=mono," +
      "apad=whole_dur=" +
      seconds +
      "," +
      "atrim=duration=" +
      seconds +
      ",asetpts=PTS-STARTPTS[a" +
      index +
      "]"
    );
  });
  filters.push(
    plan.sections.map((_, index) => "[a" + index + "]").join("") +
      "concat=n=" +
      plan.sections.length +
      ":v=0:a=1[outa]",
  );
  command(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      ...speechPaths.flatMap((path) => ["-protocol_whitelist", "file,pipe", "-i", path]),
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[outa]",
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "1",
      output,
    ],
    120000,
  );
  const details = probe(output);
  assert.equal(details.streams.length, 1);
  assert.equal(details.streams[0].codec_name, "pcm_s16le");
  assert.equal(details.streams[0].sample_rate, "48000");
  assert.ok(
    Math.abs(Number(details.format.duration) - plan.totalSeconds) <= 0.05,
    "One continuous audio master must match frame-aligned narration duration",
  );
  return output;
}

async function renderMovie(pngPaths, audioPath, plan, directory) {
  const beats = plan.sections.flatMap((section) => section.visualBeats);
  assert.equal(pngPaths.length, beats.length);
  const lines = ["ffconcat version 1.0"];
  for (const [index, beat] of beats.entries()) {
    // Paths are generated inside the private CI temp directory, not user-provided.
    assert.ok(!pngPaths[index].includes("'") && !pngPaths[index].includes("\n"));
    lines.push("file '" + pngPaths[index] + "'");
    lines.push("duration " + (beat.frames / FPS).toFixed(9));
  }
  lines.push("file '" + pngPaths.at(-1) + "'");
  const framesFile = join(directory, "frames.ffconcat");
  await writeFile(framesFile, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
  const startTimes = beats.map((beat) => (beat.startFrame / FPS).toFixed(6));
  const xMotion = startTimes
    .slice()
    .reverse()
    .reduce(
      (otherwise, start) =>
        "if(between(t," + start + "," + (Number(start) + 1.55).toFixed(6) +
        "),-420+512*min(max(t-" + start + ",0)/1.4,1)," + otherwise + ")",
      "-420",
    );
  const filters =
    "[0:v]fps=24,format=yuv420p[slides];" +
    "color=c=0x64d8cb:s=420x6:r=24:d=" +
    plan.totalSeconds.toFixed(6) +
    ",format=rgba[accent];" +
    "[slides][accent]overlay=x='" + xMotion +
    "':y=174:shortest=1:format=auto,format=yuv420p[finalv]";
  const output = join(directory, "ENGLISH_PIPER_NASA_REVIEW_REQUIRED.mp4");
  command(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-protocol_whitelist",
      "file,pipe",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      framesFile,
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      audioPath,
      "-filter_complex",
      filters,
      "-map",
      "[finalv]",
      "-map",
      "1:a:0",
      "-t",
      plan.totalSeconds.toFixed(6),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-movflags",
      "+faststart",
      "-metadata",
      "title=EARTH AND CLIMATE EXPLAINED - REVIEW REQUIRED",
      output,
    ],
    480000,
  );
  const details = probe(output);
  const video = details.streams.find((stream) => stream.codec_type === "video");
  const audio = details.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video?.codec_name, "h264");
  assert.equal(audio?.codec_name, "aac");
  assert.equal(video?.width, 1280);
  assert.equal(video?.height, 720);
  assert.ok(
    Math.abs(Number(video.nb_frames) - plan.totalFrames) <= 2,
    "Video frame count must match voice-driven timeline",
  );
  assert.ok(
    Math.abs(Number(details.format.duration) - plan.totalSeconds) <= 0.2,
    "Movie duration must match the voice-driven timeline",
  );
  assert.ok(
    Number(details.format.duration) >= 480 && Number(details.format.duration) <= 600,
    "Episode must be 8–10 minutes, not padded with empty shots",
  );
  const size = (await stat(output)).size;
  assert.ok(size > 100000 && size < 140 * 1024 * 1024);
  return { output, duration: Number(details.format.duration), size };
}

async function main() {
  const story = JSON.parse(await readFile(STORY_PATH, "utf8"));
  const { sources, totalWords } = validateStory(story);
  const rights = buildOfflineVideoCreditsReport({ videoId: VIDEO_ID, assets: [] });
  assert.equal(rights.status, "BLOCKED");
  assert.equal(rights.renderAllowed, false);
  assert.equal(rights.uploadAllowed, false);
  await prepareVoice();
  const images = await prepareVisualAssets();
  command("rsvg-convert", ["--version"], 10000);
  command("ffmpeg", ["-hide_banner", "-version"], 10000);

  const privateRoot = "/home/ap/videonews-previews";
  const lockPath = join(privateRoot, ".full-english-piper-render.lock");
  let locked = false;
  if (LOCAL_PREVIEW) {
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(privateRoot);
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
    assert.equal(rootInfo.uid, process.getuid());
    assert.equal(rootInfo.mode & 0o077, 0);
    assert.equal(await realpath(privateRoot), privateRoot);
    const disk = await statfs(privateRoot);
    assert.ok(disk.bavail * disk.bsize >= 1024 * 1024 * 1024,
      "At least 1 GiB free disk for full private video");
    const lock = await open(lockPath, "wx", 0o600);
    await lock.close();
    locked = true;
  }
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), "vns-full-english-piper-"));
    const { paths, plan } = await synthesizeSections(story, directory);
    console.log("ENGLISH_FULL_AUDIO_DURATION_SECONDS=" + plan.totalSeconds.toFixed(3));
    console.log("ENGLISH_FULL_SECTIONS=7; ENGLISH_FULL_WORDS=" + totalWords +
      "; ENGLISH_VISUAL_BEATS=19");
    const pngPaths = await renderGraphics(story, sources, images, directory);
    if (CI_AUDIO_ONLY) {
      console.log("P3 FULL ENGLISH AUDIO AND 19 GRAPHIC PROOF PASS: " +
        plan.totalSeconds.toFixed(3) + " seconds; 7 canonical sections; " +
        pngPaths.length + " photo-backed original graphics; NO MP4 IN CI");
      return;
    }
    const audio = await assembleAudio(paths, plan, directory);
    const movie = await renderMovie(pngPaths, audio, plan, directory);
    const sha256 = createHash("sha256").update(await readFile(movie.output)).digest("hex");
    const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
    const base = "earth-climate-explained-ozone-2026-piper-nasa-" +
      stamp + "-" + randomBytes(4).toString("hex");
    const tempOut = join(privateRoot, "." + base + ".partial");
    const finalOut = join(privateRoot, base + ".mp4");
    try {
      await copyFile(movie.output, tempOut, fsConstants.COPYFILE_EXCL);
      await chmod(tempOut, 0o600);
      assert.equal((await stat(tempOut)).size, movie.size);
      await rename(tempOut, finalOut);
    } catch (error) {
      await rm(tempOut, { force: true });
      throw error;
    }
    assert.equal(story.editorialApproved, false);
    assert.equal(story.publicationAllowed, false);
    assert.equal(rights.renderAllowed, false);
    assert.equal(rights.uploadAllowed, false);
    console.log("VNS_PRIVATE_FULL_ENGLISH_PATH=" + finalOut);
    console.log("VNS_PRIVATE_FULL_ENGLISH_SHA256=" + sha256);
    console.log("P3 FULL PRIVATE ENGLISH PIPER NASA VIDEO PASS: " +
      movie.duration.toFixed(3) + " seconds; " + totalWords + " words; " +
      pngPaths.length + " photo-backed original graphic beats; H264/AAC; bytes=" +
      movie.size + "; SHA256=" + sha256);
    console.log("Editorial/publication: DENIED. Piper Lessac: private demo voice only.");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (locked) await rm(lockPath, { force: true });
  }
}

await main();
