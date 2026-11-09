#!/usr/bin/env node
/**
 * English Earth & Climate Explained CI-only, review-required video proof.
 * Local original SVGs and the OS-provided synthetic voice only. No networking,
 * third-party media, paid API, credentials, VPS writes or production rendering.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEarthClimateExplainedStructure,
  EARTH_CLIMATE_EXPLAINED_SECTION_IDS,
  buildNarrationTimeline,
  buildOfflineVideoCreditsReport,
  makeOfflineGraphicStoryboard,
} from "../packages/shared/dist/index.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("REFUSED: English narrated preview is isolated GitHub Actions CI only");
}

const STORY_PATH = new URL("../content/news/ozone-2026-explained-en.json", import.meta.url);
const STORY_ID = "00000000-0000-4000-8000-000000000480";
const VIDEO_ID = "00000000-0000-4000-8000-000000000481";
const FPS = 24;
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

async function synthesizeSections(story, directory, speed) {
  const paths = [];
  const timings = [];
  for (const [index, section] of story.sections.entries()) {
    const path = join(directory, "speech-" + index + ".wav");
    command(
      "espeak-ng",
      ["-v", "en-us", "-s", String(speed), "-w", path, section.narration],
      30000,
    );
    const details = probe(path);
    const stream = details.streams.find((value) => value.codec_type === "audio");
    assert.equal(stream?.codec_name, "pcm_s16le");
    assert.equal(stream?.channels, 1);
    const seconds = Number(details.format.duration);
    assert.ok(Number.isFinite(seconds) && seconds > 3 && seconds < 240);
    paths.push(path);
    timings.push({
      sectionId: section.id,
      audioSeconds: seconds,
      beatCount: section.visuals.length,
    });
  }
  return { paths, plan: buildNarrationTimeline(timings, 0.7) };
}

async function renderGraphics(story, sources, directory) {
  const pngPaths = [];
  for (const section of story.sections) {
    const sourceUrls = section.sourceIds.slice(0, 3).map((id) => sources.get(id).url);
    for (const visual of section.visuals) {
      const result = makeOfflineGraphicStoryboard({
        storyId: STORY_ID,
        language: "en-US",
        publisherApproved: true, // Deliberately forged. Must not bypass gate.
        uploadAllowed: true,
        scenes: [{ ...visual, sourceUrls }],
      });
      assert.equal(result.status, "PREVIEW_ONLY", JSON.stringify(result.errors));
      assert.equal(result.frames.length, 1);
      assert.equal(result.videoRenderAllowed, false);
      assert.equal(result.uploadAllowed, false);
      assert.equal(result.sourcesVerified, false);
      const svg = result.frames[0].svg;
      assert.match(svg, /PREVIEW – NOT FOR PUBLICATION/);
      assert.doesNotMatch(svg, /VORSCHAU|Quellenlinks|<image\b|<script\b|<foreignObject\b/);
      const label = String(pngPaths.length + 1).padStart(2, "0");
      const svgPath = join(directory, "visual-" + label + ".svg");
      const png = join(directory, "visual-" + label + ".png");
      await writeFile(svgPath, svg, { mode: 0o600, flag: "wx" });
      command("rsvg-convert", ["--output", png, svgPath], 30000);
      assert.equal((await readFile(png)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      pngPaths.push(png);
    }
  }
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
  const output = join(directory, "ENGLISH_REVIEW_REQUIRED_NOT_FOR_PUBLICATION.mp4");
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
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-vf",
      "fps=24,format=yuv420p",
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
  assert.ok(size > 100000 && size < 80 * 1024 * 1024);
  return { output, duration: Number(details.format.duration), size };
}

async function main() {
  const story = JSON.parse(await readFile(STORY_PATH, "utf8"));
  const { sources, totalWords } = validateStory(story);
  const rights = buildOfflineVideoCreditsReport({ videoId: VIDEO_ID, assets: [] });
  assert.equal(rights.status, "BLOCKED");
  assert.equal(rights.renderAllowed, false);
  assert.equal(rights.uploadAllowed, false);
  command("espeak-ng", ["--version"], 10000);
  command("rsvg-convert", ["--version"], 10000);
  command("ffmpeg", ["-hide_banner", "-version"], 10000);
  const directory = await mkdtemp(join(tmpdir(), "vns-en-explained-ci-"));
  try {
    let voiceSpeed = 145;
    let { paths, plan } = await synthesizeSections(story, directory, voiceSpeed);
    if (plan.totalSeconds < 480 || plan.totalSeconds > 600) {
      // Keep a bounded, intelligible pace; never stretch video with silence.
      voiceSpeed = Math.max(130, Math.min(175, Math.round((voiceSpeed * plan.totalSeconds) / 540)));
      ({ paths, plan } = await synthesizeSections(story, directory, voiceSpeed));
    }
    assert.ok(
      plan.totalSeconds >= 480 && plan.totalSeconds <= 600,
      "Source script and measured voice duration must fit the 8–10 minute brief",
    );
    const pngPaths = await renderGraphics(story, sources, directory);
    const audio = await assembleAudio(paths, plan, directory);
    const movie = await renderMovie(pngPaths, audio, plan, directory);
    const sha256 = createHash("sha256")
      .update(await readFile(movie.output))
      .digest("hex");
    assert.equal(story.editorialApproved, false);
    assert.equal(story.publicationAllowed, false);
    assert.equal(rights.renderAllowed, false);
    console.log(
      "ENGLISH EXPLAINED OFFLINE CI PASS: " +
        movie.duration.toFixed(3) +
        " sec; " +
        totalWords +
        " words; " +
        pngPaths.length +
        " own graphics; speech speed=" +
        voiceSpeed +
        "; bytes=" +
        movie.size +
        "; SHA256=" +
        sha256,
    );
    console.log(
      "EN-US metadata, review-required original narration; deterministic sequential audio.",
    );
    console.log("TTS is eSpeak technical-only, NOT a production-quality voice.");
    console.log(
      "Editorial approval: DENIED. Licensed media: NONE. Render/upload/publication: NOT ENABLED.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
