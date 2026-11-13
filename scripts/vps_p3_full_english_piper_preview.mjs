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
  encodeCinematicSpan,
  encodeGraphicTail,
  loadCinematicTimeline,
} from "./p3_cinematic_timeline.mjs";
import {
  createPrivateClipOverlaySvg,
  encodePrivateClipBeat,
  loadPrivateClipAssignments,
} from "./p3_private_clip_support.mjs";
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
const VISUAL_ASSETS = Object.freeze([
  {
    filename: "earth-nasa.jpg",
    sha256: "872e1a5317ac31612a766ef6dfa7e774e2d10509b1e564b38e3aa384d6b0bf19",
    credit: "NASA / Suomi NPP (PIA18033)",
  },
  {
    filename: "ozone-2026-nasa.jpg",
    sha256: "22b83f5dab6248d401e5ac313f98a18626b8c1ca002e43b67209d56f69ce0c6d",
    credit: "NASA Earth Observatory / Lauren Dauphin · ozone data 2026",
    insetLabel: "NASA EO · ozone map · 2026",
  },
  {
    filename: "PIA00117.jpg",
    sha256: "18cced99e3516bf3720b7bb9040724cabcaf2fc1fe97da7754df69a0b303e70e",
    credit: "NASA/JPL · Ross Ice Shelf · archive 1990",
  },
  {
    filename: "PIA00728.jpg",
    sha256: "53119b3ef93d47bb842cfa4e2df2e0253adc9f24b1836755b5ffab041023f50f",
    credit: "NASA/JPL · Galileo Earth views · archive",
  },
  {
    filename: "PIA20664.jpg",
    sha256: "58aff245ac9f2b6c0c5af05829c6c21b03c59382cc44e9e092157cc76749b9e4",
    credit: "NASA/JPL-Caltech · ozone vortex 2014 data",
    insetLabel: "NASA/JPL-Caltech · vortex · 2014",
  },
  {
    filename: "PIA00116.jpg",
    sha256: "5a2fa81a95ec1bd03119fcc7ead8c162e061311705d964d92712fe0cc02166ab",
    credit: "NASA/JPL · Antarctic limb mosaic · archive 1990",
  },
]);
/**
 * A source photo may appear in exactly one beat. null means an original
 * graphic without any recycled background. Do not silently duplicate files,
 * crop, zoom, or re-color a photo to work around this restriction.
 */
const BEAT_VISUAL_ASSET = Object.freeze([
  1, null,           // Hook: contemporary ozone image, then original graphic
  0, null, null,     // Basics: Earth photo, then diagrams
  null, null, 4,     // Measurements: comparison diagrams and dated 2014 vortex
  2, null, 5,        // Why: Antarctic archive, graphic, archival limb mosaic
  null, 3, null,     // Why it matters: original graphics, archival Earth views
  null, null, null,  // Next: data/monitoring explanations as original graphics
  null, null,        // Takeaway: original graphics only
]);
assert.equal(BEAT_VISUAL_ASSET.length, 19);
const photoBeats = BEAT_VISUAL_ASSET.filter(index => index !== null);
assert.equal(photoBeats.length, VISUAL_ASSETS.length);
assert.equal(new Set(photoBeats).size, photoBeats.length,
  "The same source photo must never appear twice in one episode");
assert.deepEqual([...photoBeats].sort((a, b) => a - b),
  VISUAL_ASSETS.map((_, index) => index));
assert.equal(new Set(VISUAL_ASSETS.map(a => a.sha256)).size, VISUAL_ASSETS.length,
  "Distinct asset filenames must not hide duplicate image bytes");

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
      name + " failed; status=" + String(result.status) +
      "; signal=" + String(result.signal) +
      "; code=" + String(result.error?.code ?? "none") +
      "; stderr=" + (result.stderr ?? "").slice(-1200),
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
    assert.ok(video?.width >= 700 && video?.height >= 420,
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
    const path = join(directory, "speech-" + index + ".wav");
    if (index === 0) {
      // Isolate the first complete sentence so a long TTS input cannot
      // corrupt the beginning of the whole narration. Retain every word.
      const match = /^([^.!?]+[.!?])\s+([\s\S]+)$/.exec(section.narration);
      assert.ok(match && match[1].length >= 30 && match[2].length > 30,
        "Intro must split at the first full stop without losing text");
      assert.equal(match[1] + " " + match[2], section.narration);
      const shortWavs = [];
      for (const [part, text] of [match[1], match[2]].entries()) {
        const input = join(directory, "opening-" + part + ".txt");
        const wave = join(directory, "opening-" + part + ".wav");
        await writeFile(input, text, { mode: 0o600, flag: "wx" });
        command(process.env.VNS_PIPER_PYTHON, [
          "-m", "piper", "-m", process.env.VNS_PIPER_MODEL,
          "--length-scale", PIPER_LENGTH_SCALE,
          "--sentence-silence", PIPER_SENTENCE_SILENCE,
          "--input-file", input, "-f", wave,
        ], 180000);
        const details = probe(wave);
        assert.equal(details.streams.find(v => v.codec_type === "audio")?.channels, 1);
        assert.ok(Number(details.format.duration) > 2.0);
        shortWavs.push(wave);
      }
      // 180 ms clean pre-roll and a short fade-in prevent an abrupt opening
      // sample edge; no word is trimmed, and the first sentence stays whole.
      command("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", shortWavs[0], "-i", shortWavs[1],
        "-filter_complex",
        "[0:a]aresample=22050,adelay=180,afade=t=in:st=0.18:d=0.12[a0];" +
          "[1:a]aresample=22050[a1];" +
          "[a0][a1]concat=n=2:v=0:a=1[out]",
        "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "22050", "-ac", "1",
        path,
      ], 120000);
      console.log("INTRO_CLEAN_ONSET=isolated_first_sentence; preroll_ms=180; fade_ms=120");
    } else {
      const input = join(directory, "section-" + index + ".txt");
      await writeFile(input, section.narration, { mode: 0o600, flag: "wx" });
      command(process.env.VNS_PIPER_PYTHON, [
        "-m", "piper",
        "-m", process.env.VNS_PIPER_MODEL,
        "--length-scale", PIPER_LENGTH_SCALE,
        "--sentence-silence", PIPER_SENTENCE_SILENCE,
        "--input-file", input,
        "-f", path,
      ], 180000);
    }
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
  const sceneImagesUsed = new Set();
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
      assert.doesNotMatch(svg, /VORSCHAU|Quellenlinks|<image\\b|<script\\b|<foreignObject\\b/);
      const opaque = '<rect x="0" y="0" width="1280" height="720" fill="#0a1929"/>';
      assert.ok(svg.includes(opaque));
      const imageIndex = BEAT_VISUAL_ASSET[index];
      const photoBacked = imageIndex !== null;
      if (photoBacked) {
        assert.ok(Number.isInteger(imageIndex) && backgrounds[imageIndex],
          "Every photo-backed beat needs an approved NASA image");
        assert.ok(!sceneImagesUsed.has(imageIndex),
          "Source photo reused in multiple scenes: " + VISUAL_ASSETS[imageIndex].filename);
        sceneImagesUsed.add(imageIndex);
        // Preserve legible text without obscuring the source photograph completely.
        svg = svg.replace(opaque,
          '<rect x="0" y="0" width="1280" height="720" ' +
          'fill="#071420" fill-opacity="0.60"/>');
        const credit = VISUAL_ASSETS[imageIndex].credit;
        svg = svg.replace("</svg>",
          '<text x="92" y="650" font-size="15" fill="#c9dbe7" ' +
          'font-family="Arial, sans-serif">' + credit + '</text></svg>');
      }
      const label = String(index + 1).padStart(2, "0");
      const svgPath = join(directory, "visual-" + label + ".svg");
      const foreground = join(directory, "foreground-" + label + ".png");
      const png = join(directory, "visual-" + label + ".png");
      await writeFile(svgPath, svg, { mode: 0o600, flag: "wx" });
      command("rsvg-convert", ["--output", foreground, svgPath], 30000);
      if (photoBacked) {
        command("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-i", backgrounds[imageIndex],
          "-i", foreground,
          "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto[final]",
          "-map", "[final]",
          "-frames:v", "1", png,
        ], 120000);
      } else {
        // The native SVG contains its own opaque backdrop and remains a
        // distinct, self-contained informational graphic.
        await copyFile(foreground, png, fsConstants.COPYFILE_EXCL);
      }
      assert.equal((await readFile(png)).subarray(0, 8).toString("hex"),
        "89504e470d0a1a0a");
      pngPaths.push(png);
    }
  }
  assert.equal(pngPaths.length, 19);
  assert.equal(sceneImagesUsed.size, VISUAL_ASSETS.length);
  console.log("NASA_DISTINCT_SCENE_BACKGROUNDS=" + sceneImagesUsed.size);
  console.log("UNIQUE_PHOTO_BEATS=" + sceneImagesUsed.size +
    "; ORIGINAL_GRAPHIC_ONLY_BEATS=" + (pngPaths.length - sceneImagesUsed.size) +
    "; DUPLICATE_IMAGE_INSETS=0");
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

/**
 * A long-lived FFmpeg filter graph on a small VPS may be terminated by the
 * OS, without diagnostic stderr. Encode each graphic beat separately (with
 * one CPU encoding thread), then losslessly concat the identical H264
 * bitstreams. Audio is combined and AAC-encoded only once, at the end.
 * Never scale or translate text; move only the decorative underline.
 */
async function renderMovie(
  pngPaths, audioPath, plan, directory, smoke = false,
  privateClips = new Map(), cinematic = null,
) {
  const beats = plan.sections.flatMap((section) => section.visualBeats);
  assert.equal(pngPaths.length, beats.length);
  const selected = smoke ? pngPaths.slice(0, 2) : pngPaths;
  const frameCounts = smoke ? [36, 36] : beats.map((beat) => beat.frames);
  assert.equal(selected.length, frameCounts.length);
  assert.ok(privateClips instanceof Map);
  if (privateClips.size || cinematic?.starts.size || cinematic?.inserts.size) {
    assert.ok(!smoke && LOCAL_PREVIEW,
      "Reviewed moving footage is allowed only in a private VPS preview");
  }
  assert.ok(!(privateClips.size &&
    (cinematic?.starts.size || cinematic?.inserts.size)),
    "Choose only one private footage mode");
  if (smoke) {
    assert.ok(CI_AUDIO_ONLY, "Short video encoder smoke only in disposable CI");
    assert.equal(selected.length, 2);
  } else {
    assert.equal(selected.length, 19);
    assert.equal(frameCounts.reduce((sum, frames) => sum + frames, 0), plan.totalFrames);
    if (cinematic) assert.equal(cinematic.timelineFrames, plan.totalFrames,
      "Cinematic edit decision list must match narration exactly");
  }
  const cinematicEndBeats = new Set(
    cinematic ? [...cinematic.starts.values()].map(span => span.end) : [],
  );
  const encodedClips = [];
  for (let index = 0; index < selected.length;) {
    const span = cinematic?.starts.get(index);
    const insert = cinematic?.inserts.get(index);
    assert.ok(!(span && insert), "Full span and short insert cannot overlap");
    const frames = span ? span.durationFrames : frameCounts[index];
    assert.ok(Number.isSafeInteger(frames) &&
      frames >= 24 && frames < 24 * 3 * 240);
    const encoded = join(
      directory,
      "scene-" + String(index + 1).padStart(2, "0") + ".mp4",
    );
    if (span) {
      assert.equal(
        frameCounts.slice(span.start, span.end + 1).reduce((sum, n) => sum + n, 0),
        span.durationFrames,
      );
      await encodeCinematicSpan({span, output: encoded, directory});
    } else if (insert) {
      const tailFrames = frameCounts[index] - insert.durationFrames;
      assert.ok(tailFrames >= FPS,
        "Short insert must leave a graphic remainder of at least one second");
      // One source shot, played once. The rest of the narrated beat uses
      // its original SVG scene rather than looping a short video.
      await encodeCinematicSpan({span: insert, output: encoded, directory});
      const media = probe(encoded);
      assert.equal(Number(media.streams.find(stream =>
        stream.codec_type === "video")?.nb_frames), insert.durationFrames);
      encodedClips.push(encoded);
      const tail = join(directory,
        "scene-" + String(index + 1).padStart(2, "0") + "-graphic-tail.mp4");
      await encodeGraphicTail({
        imagePath: selected[index], output: tail, frames: tailFrames,
      });
      encodedClips.push(tail);
      console.log("VIDEO_SHORT_INSERT_BEAT=" + (index + 1) +
        "; clip_frames=" + insert.durationFrames +
        "; graphic_remainder_frames=" + tailFrames);
      index += 1;
      continue;
    } else {
      assert.ok(!cinematic?.occupied.has(index),
        "A cinematic background may not be rendered as a duplicate still");
      const path = selected[index];
      const fadeSeconds = (10 / FPS).toFixed(6);
      const fadeOutStart = ((frames - 10) / FPS).toFixed(6);
      const fadeIn = cinematicEndBeats.has(index - 1)
        ? ",fade=t=in:st=0:d=" + fadeSeconds : "";
      const fadeOut = cinematic?.starts.has(index + 1)
        ? ",fade=t=out:st=" + fadeOutStart + ":d=" + fadeSeconds : "";
      const filter =
        "[0:v]format=yuv420p[fixed];" +
        "color=c=0x64d8cb:s=420x6:r=24,format=rgba[accent];" +
        "[fixed][accent]overlay=x='-420+512*min(t/1.4,1)'" +
        ":y=174:shortest=1:format=auto,format=yuv420p" +
        fadeIn + fadeOut + "[finalv]";
      const approvedClip = privateClips.get(index);
      if (approvedClip) {
        const overlaySvg = join(directory, "clip-overlay-" + String(index + 1) + ".svg");
        const overlayPng = join(directory, "clip-overlay-" + String(index + 1) + ".png");
        await writeFile(overlaySvg, createPrivateClipOverlaySvg({
          title: approvedClip.title,
          credit: approvedClip.credit,
          captureDate: approvedClip.captureDate,
        }), { mode: 0o600, flag: "wx" });
        command("rsvg-convert", ["--output", overlayPng, overlaySvg], 30000);
        await encodePrivateClipBeat({
          assignment: approvedClip, overlayPng, output: encoded, frames,
        });
      } else {
        command("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-filter_complex_threads", "1", "-threads", "1",
          "-loop", "1", "-framerate", String(FPS),
          "-protocol_whitelist", "file,pipe", "-i", path,
          "-filter_complex", filter,
          "-map", "[finalv]", "-frames:v", String(frames),
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
          "-threads:v", "1",
          "-pix_fmt", "yuv420p", "-r", String(FPS),
          "-an", "-movflags", "+faststart",
          encoded,
        ], 360000);
      }
    }
    const clip = probe(encoded);
    const video = clip.streams.find((stream) => stream.codec_type === "video");
    assert.equal(video?.codec_name, "h264");
    assert.equal(video?.width, 1280);
    assert.equal(video?.height, 720);
    assert.equal(Number(video?.nb_frames), frames);
    encodedClips.push(encoded);
    console.log(
      "VIDEO_SCENE_ENCODED=" + (index + 1) + "-" +
      (span ? span.end + 1 : index + 1) + "/" + selected.length +
      "; frames=" + frames + "; cinematic=" + Boolean(span),
    );
    index = span ? span.end + 1 : index + 1;
  }

  // The encoded MP4 segments share encoder profile, dimensions, fps and
  // pixel format, so video can be copied into one continuous track without
  // keeping the entire 8-minute episode in a live filter graph.
  const concat = join(directory, "encoded-scenes.ffconcat");
  const list = ["ffconcat version 1.0"];
  for (const clip of encodedClips) {
    assert.ok(!clip.includes("'") && !clip.includes("\n"));
    list.push("file '" + clip + "'");
  }
  await writeFile(concat, list.join("\n") + "\n", {
    mode: 0o600, flag: "wx",
  });
  const joined = join(directory, "joined-video-track.mp4");
  command("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "0",
    "-i", concat,
    "-map", "0:v:0", "-c:v", "copy", "-an",
    "-movflags", "+faststart",
    joined,
  ], 120000);
  const expectedFrames = frameCounts.reduce((sum, n) => sum + n, 0);
  const duration = expectedFrames / FPS;
  const joinedVideo = probe(joined);
  const joinedStream = joinedVideo.streams.find(
    (stream) => stream.codec_type === "video",
  );
  assert.equal(Number(joinedStream?.nb_frames), expectedFrames);
  assert.ok(Math.abs(Number(joinedVideo.format.duration) - duration) < 0.1);

  const output = join(
    directory,
    smoke ? "CI_ONLY_3_SECOND_VIDEO_SMOKE.mp4" : "ENGLISH_PIPER_NASA_REVIEW_REQUIRED.mp4",
  );
  command("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-protocol_whitelist", "file,pipe", "-i", joined,
    "-protocol_whitelist", "file,pipe", "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-t", duration.toFixed(6), "-c:v", "copy",
    "-c:a", "aac", "-b:a", "128k",
    "-ar", "48000", "-ac", "1", "-movflags", "+faststart",
    "-metadata", "title=EARTH AND CLIMATE EXPLAINED - REVIEW REQUIRED",
    output,
  ], 120000);
  const details = probe(output);
  const video = details.streams.find((stream) => stream.codec_type === "video");
  const audio = details.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video?.codec_name, "h264");
  assert.equal(audio?.codec_name, "aac");
  assert.equal(video?.width, 1280);
  assert.equal(video?.height, 720);
  assert.equal(Number(video?.nb_frames), expectedFrames);
  assert.ok(Math.abs(Number(details.format.duration) - duration) <= 0.2);
  if (smoke) {
    assert.ok(duration === 3);
    console.log("THREE_SECOND_SEGMENTED_H264_AAC_SMOKE=PASS");
  } else {
    assert.ok(Math.abs(duration - plan.totalSeconds) <= 0.01);
    assert.ok(Number(details.format.duration) >= 480 &&
      Number(details.format.duration) <= 600,
    "Episode must be 8–10 minutes, never padded with empty shots");
  }
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
    let privateClips = new Map();
    let cinematic = null;
    const cinematicPath = process.env.VNS_CINEMATIC_MEDIA_MANIFEST;
    const manifestPath = process.env.VNS_PRIVATE_MEDIA_MANIFEST;
    assert.ok(!(cinematicPath && manifestPath),
      "Specify only one reviewed private footage manifest");
    if (cinematicPath !== undefined) {
      assert.ok(LOCAL_PREVIEW,
        "Cinematic media is forbidden in CI and other unapproved modes");
      const beats = plan.sections.flatMap(section => section.visualBeats);
      cinematic = await loadCinematicTimeline({
        manifestPath: cinematicPath,
        beatVisualAssets: BEAT_VISUAL_ASSET,
        beatFrames: beats.map(beat => beat.frames),
        beatVisuals: story.sections.flatMap(section => section.visuals),
      });
      console.log("CINEMATIC_BACKGROUND_SPANS=" + cinematic.starts.size +
        "; SHORT_VIDEO_INSERTS=" + cinematic.inserts.size +
        "; CINEMATIC_OVERLAY_BEATS=" + cinematic.occupied.size);
    }
    if (manifestPath !== undefined) {
      assert.ok(LOCAL_PREVIEW,
        "Private media manifest is forbidden in CI and other unapproved modes");
      const beats = plan.sections.flatMap(section => section.visualBeats);
      privateClips = await loadPrivateClipAssignments({
        manifestPath,
        beatVisualAssets: BEAT_VISUAL_ASSET,
        beatFrames: beats.map(beat => beat.frames),
        beatTitles: story.sections.flatMap(section =>
          section.visuals.map(visual => visual.title)),
      });
      console.log("PRIVATE_REVIEWED_VIDEO_BEATS=" + privateClips.size);
    }
    const pngPaths = await renderGraphics(story, sources, images, directory);
    if (CI_AUDIO_ONLY) {
      // Prove the *actual* encode/concat/mux pipeline with a tiny 3-second
      // disposable video. A full 8–10 minute MP4 is still VPS-only.
      await renderMovie(pngPaths, paths[0], plan, directory, true);
      console.log("P3 FULL ENGLISH AUDIO AND 19 GRAPHIC PROOF PASS: " +
        plan.totalSeconds.toFixed(3) + " seconds; 7 canonical sections; " +
        pngPaths.length + " original graphic scenes; NO FULL MP4 IN CI");
      return;
    }
    const audio = await assembleAudio(paths, plan, directory);
    const movie = await renderMovie(
      pngPaths, audio, plan, directory, false, privateClips, cinematic,
    );
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
      movie.size + "; reviewed_clip_beats=" + privateClips.size +
      "; cinematic_spans=" + (cinematic?.starts.size ?? 0) +
      "; short_inserts=" + (cinematic?.inserts.size ?? 0) + "; SHA256=" + sha256);
    console.log("Editorial/publication: DENIED. Piper Lessac: private demo voice only.");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
    if (locked) await rm(lockPath, { force: true });
  }
}

await main();
