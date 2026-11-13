#!/usr/bin/env node
/**
 * P3-09 experimental cinematic spans. A single reviewed, local video may
 * continue behind two or three independent story overlays.
 *
 * The caller retains the continuous narration master. This module produces
 * video-only H264 segments; never downloads, licenses, uploads or publishes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { validateEpisodeMediaManifest } from "./check_episode_media_manifest.mjs";

const FPS = 24;
const BEATS = 19;
const TRANSITION_FRAMES = 10;
const MANIFEST_MAX_BYTES = 256 * 1024;
const utf = input => String(input).replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function command(name, args, timeout = 120000) {
  const result = spawnSync(name, args, {
    shell: false, encoding: "utf8", timeout, maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  if (result.error || result.status !== 0) {
    throw new Error("CINEMATIC_COMMAND_FAILED " + name +
      " status=" + String(result.status) +
      " code=" + String(result.error?.code ?? "none") +
      " stderr=" + (result.stderr ?? "").slice(-1100));
  }
  return result.stdout;
}

function probe(file) {
  return JSON.parse(command("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file,pipe",
    "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,nb_frames",
    "-of", "json", file,
  ], 15000));
}

export function parseBeatId(id) {
  const match = /^beat-(0[1-9]|1[0-9])$/.exec(id);
  assert.ok(match, "Cinematic beat identifier must be beat-01 to beat-19");
  return Number(match[1]) - 1;
}

/**
 * Build a frame-exact edit decision list. A span references its source motif
 * once even when three successive editorial overlays refer to it.
 */
export async function planCinematicTimeline({
  manifest, assetRoot, beatVisualAssets, beatFrames, beatVisuals,
}) {
  assert.ok(Array.isArray(beatVisualAssets) && beatVisualAssets.length === BEATS);
  assert.ok(Array.isArray(beatFrames) && beatFrames.length === BEATS);
  assert.ok(Array.isArray(beatVisuals) && beatVisuals.length === BEATS);
  for (const count of beatFrames)
    assert.ok(Number.isSafeInteger(count) && count >= 24 && count < FPS * 240);
  const checked = await validateEpisodeMediaManifest(manifest, assetRoot);
  assert.equal(checked.assets, manifest.assets.length);
  const starts = new Map(), inserts = new Map(), occupied = new Set();
  const timelineFrames = beatFrames.reduce((sum, frames) => sum + frames, 0);
  for (const asset of manifest.assets) {
    assert.equal(asset.kind, "video", "Cinematic background requires a reviewed video");
    assert.ok(asset.path.endsWith(".mp4"), "Only local H264 MP4 is supported");
    assert.ok(typeof asset.endSceneId === "string", "Missing endSceneId");
    const start = parseBeatId(asset.sceneId);
    const end = parseBeatId(asset.endSceneId);
    assert.ok(end >= start && end - start <= 2,
      "A cinematic video may span one to three consecutive beats");
    const isInsert = Object.hasOwn(asset, "insertFrames");
    if (isInsert) {
      assert.equal(end, start,
        "Short inserts must remain within one editorial beat");
      assert.ok(Number.isSafeInteger(asset.insertFrames) &&
        asset.insertFrames >= 48 &&
        asset.insertFrames <= beatFrames[start] - FPS,
        "Short insert needs >=2 seconds of footage and >=1 second graphic remainder");
    }
    for (let i = start; i <= end; i++) {
      assert.equal(beatVisualAssets[i], null,
        "Cannot replace a photo-backed scene with video");
      assert.ok(!occupied.has(i), "Cinematic spans must not overlap");
      occupied.add(i);
    }
    const frames = beatFrames.slice(start, end + 1);
    const durationFrames = isInsert
      ? asset.insertFrames
      : frames.reduce((sum, count) => sum + count, 0);
    const metadata = probe(asset.path);
    const videos = metadata.streams.filter(stream => stream.codec_type === "video");
    assert.equal(videos.length, 1, "One video track required");
    assert.equal(videos[0].codec_name, "h264", "Source must be H264");
    assert.ok(videos[0].width >= 640 && videos[0].height >= 360,
      "Source video smaller than 640x360");
    assert.ok(Number(metadata.format.duration) >= durationFrames / FPS + 0.1,
      "Source cannot be looped or frozen to fill the cinematic span");
    const planned = Object.freeze({
      start, end, frames: isInsert ? [durationFrames] : frames, durationFrames,
      path: asset.path, sha256: asset.sha256,
      credit: asset.credit, captureDate: asset.captureDate,
      visuals: beatVisuals.slice(start, end + 1),
      motifId: asset.motifId,
    });
    if (isInsert) inserts.set(start, planned);
    else starts.set(start, planned);
  }
  return {starts, inserts, occupied, timelineFrames};
}

export async function loadCinematicTimeline({
  manifestPath, beatVisualAssets, beatFrames, beatVisuals,
}) {
  assert.ok(typeof manifestPath === "string" && isAbsolute(manifestPath),
    "Absolute private manifest path required");
  const info = await lstat(manifestPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() &&
    info.size > 2 && info.size <= MANIFEST_MAX_BYTES);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(typeof manifest.assetRoot === "string" && isAbsolute(manifest.assetRoot));
  return planCinematicTimeline({
    manifest, assetRoot: manifest.assetRoot, beatVisualAssets, beatFrames, beatVisuals,
  });
}

function wrapCopy(value, limit = 65, lines = 2) {
  if (typeof value !== "string") return [];
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const output = [];
  let line = "";
  for (const word of words) {
    if (line && (line.length + word.length + 1) > limit) {
      output.push(line); line = "";
      if (output.length >= lines) break;
    }
    if (word.length > limit) continue;
    line += (line ? " " : "") + word;
  }
  if (line && output.length < lines) output.push(line);
  return output;
}

/** Transparent animated-overlay surface, never an opaque PowerPoint slide. */
export function createCinematicOverlaySvg(visual, sequence) {
  assert.ok(visual && typeof visual.title === "string");
  assert.ok(visual.title.length >= 3 && visual.title.length <= 85);
  assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= BEATS);
  const rows = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<rect x="0" y="454" width="1280" height="226" fill="#071420" fill-opacity="0.74"/>',
    '<rect x="74" y="479" width="8" height="161" rx="3" fill="#64d8cb"/>',
    '<text x="102" y="515" fill="#88e9df" font-family="DejaVu Sans,sans-serif" font-size="17">EARTH &amp; CLIMATE EXPLAINED  /  ' +
    String(sequence).padStart(2, "0") + '</text>',
    '<text x="102" y="569" fill="#ffffff" font-family="DejaVu Sans,sans-serif" font-size="33" font-weight="700">' +
    utf(visual.title) + '</text>',
  ];
  if (visual.kind === "chart" && Array.isArray(visual.bars)) {
    const chart = visual.bars.slice(0, 3);
    const max = Math.max(1, ...chart.map(item => Number(item.value) || 0));
    chart.forEach((item, i) => {
      const value = Number(item.value);
      assert.ok(Number.isFinite(value) && value >= 0);
      const x = 106 + 340 * i;
      const width = Math.round(226 * Math.min(value / max, 1));
      rows.push('<text x="' + x + '" y="611" fill="#ecf7fa" font-size="17" font-family="DejaVu Sans,sans-serif">' +
        utf(String(item.label).slice(0, 34)) + '</text>');
      rows.push('<rect x="' + x + '" y="625" width="' + width +
        '" height="12" rx="4" fill="#64d8cb"/>');
      rows.push('<text x="' + (x + 240) +
        '" y="636" fill="#ffffff" font-size="17" font-family="DejaVu Sans,sans-serif">' +
        utf(value) + '</text>');
    });
  } else {
    const copy = typeof visual.body === "string" ? visual.body :
      Array.isArray(visual.entries) ? visual.entries.map(x => x.label ?? "").join(" · ") :
      "";
    const lines = wrapCopy(copy);
    lines.forEach((line, i) => rows.push(
      '<text x="102" y="' + (606 + i * 30) +
      '" fill="#dce9f2" font-size="19" font-family="DejaVu Sans,sans-serif">' +
      utf(line) + '</text>'));
  }
  rows.push("</svg>");
  return rows.join("");
}

/** Persistent provenance and preview warning, independent of overlay fades. */
export function createCinematicBrandSvg(credit, captureDate) {
  assert.ok(typeof credit === "string" && credit.length > 2 && credit.length <= 112);
  assert.match(captureDate, /^\d{4}-\d{2}-\d{2}$/);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<rect x="0" y="0" width="1280" height="65" fill="#071420" fill-opacity="0.62"/>',
    '<text x="74" y="29" fill="#fbd4b6" font-family="DejaVu Sans,sans-serif" font-size="17">PRIVATE PREVIEW – NOT FOR PUBLICATION</text>',
    '<text x="74" y="52" fill="#d4e5ed" font-family="DejaVu Sans,sans-serif" font-size="15">' +
    utf(credit + " · Recorded " + captureDate) + '</text>',
    '</svg>',
  ].join("");
}

/**
 * Single FFmpeg encode of 1-3 beats sharing one continuously moving source.
 * Overlays fade independently on their own frame intervals; no audio is used.
 * Background fades via a short dip-to-dark on clip boundaries (not xfade).
 */
export async function encodeCinematicSpan({span, output, directory}) {
  assert.ok(isAbsolute(output) && isAbsolute(directory));
  assert.ok(span && Array.isArray(span.frames) &&
    span.frames.length >= 1 && span.frames.length <= 3);
  assert.equal(span.frames.reduce((sum, n) => sum + n, 0), span.durationFrames);
  assert.ok(Number.isInteger(span.durationFrames) && span.durationFrames >= 24);
  const digest = createHash("sha256").update(await readFile(span.path)).digest("hex");
  assert.equal(digest, span.sha256, "Cinematic source changed after preflight");
  await mkdir(directory, {recursive: true, mode: 0o700});
  const overlayPaths = [];
  for (const [index, visual] of span.visuals.entries()) {
    const name = "cinematic-" + String(span.start + 1) + "-" + String(index + 1);
    const svg = join(directory, name + ".svg");
    const png = join(directory, name + ".png");
    await writeFile(svg, createCinematicOverlaySvg(visual, span.start + index + 1),
      {mode: 0o600, flag: "wx"});
    command("rsvg-convert", ["--output", png, svg], 30000);
    overlayPaths.push(png);
  }
  const brandSvg = join(directory, "cinematic-" + String(span.start + 1) + "-brand.svg");
  const brandPng = join(directory, "cinematic-" + String(span.start + 1) + "-brand.png");
  await writeFile(brandSvg, createCinematicBrandSvg(span.credit, span.captureDate),
    {mode: 0o600, flag: "wx"});
  command("rsvg-convert", ["--output", brandPng, brandSvg], 30000);
  const allImages = [...overlayPaths, brandPng];
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-threads", "1", "-filter_complex_threads", "1",
    "-protocol_whitelist", "file,pipe", "-i", span.path,
    ...allImages.flatMap(p => [
      "-loop", "1", "-framerate", String(FPS),
      "-protocol_whitelist", "file,pipe", "-i", p,
    ]),
  ];
  const fadeFrames = Math.min(TRANSITION_FRAMES, Math.floor(span.durationFrames / 5));
  const fadeSeconds = (fadeFrames / FPS).toFixed(6);
  const totalSeconds = (span.durationFrames / FPS).toFixed(6);
  const fadeOut = ((span.durationFrames - fadeFrames) / FPS).toFixed(6);
  const graph = [
    "[0:v:0]fps=24,scale=1280:720:force_original_aspect_ratio=increase," +
      "crop=1280:720,setsar=1,trim=duration=" + totalSeconds +
      ",setpts=PTS-STARTPTS,format=rgba," +
      "fade=t=in:st=0:d=" + fadeSeconds + "," +
      "fade=t=out:st=" + fadeOut + ":d=" + fadeSeconds + "[base]",
  ];
  let prior = "[base]";
  let offsetFrames = 0;
  for (const [index, frames] of span.frames.entries()) {
    const i = index + 1;
    const seconds = (frames / FPS).toFixed(6);
    const first = Math.min(TRANSITION_FRAMES, Math.floor(frames / 4));
    const interval = (first / FPS).toFixed(6);
    const fadeStart = ((frames - first) / FPS).toFixed(6);
    const offset = (offsetFrames / FPS).toFixed(6);
    graph.push("[" + i + ":v]fps=24,trim=duration=" + seconds +
      ",setpts=PTS-STARTPTS,format=rgba," +
      "fade=t=in:st=0:d=" + interval + ":alpha=1," +
      "fade=t=out:st=" + fadeStart + ":d=" + interval +
      ":alpha=1,setpts=PTS-STARTPTS+" + offset + "/TB[overlay" + i + "]");
    const outputLabel = "[scene" + i + "]";
    graph.push(prior + "[overlay" + i + "]overlay=0:0:format=auto:" +
      "repeatlast=0:eof_action=pass:enable='between(n," +
      offsetFrames + "," + (offsetFrames + frames - 1) +
      ")'" + outputLabel);
    prior = outputLabel;
    offsetFrames += frames;
  }
  assert.equal(offsetFrames, span.durationFrames);
  const brandIndex = allImages.length;
  graph.push(prior + "[" + brandIndex +
    ":v]overlay=0:0:format=auto:shortest=0," +
    "format=yuv420p[outv]");
  command("ffmpeg", [
    ...args, "-filter_complex", graph.join(";"), "-map", "[outv]",
    "-frames:v", String(span.durationFrames),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
    "-threads:v", "1", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-an", "-movflags", "+faststart", output,
  ], 360000);
  const media = probe(output);
  const video = media.streams.filter(stream => stream.codec_type === "video");
  assert.equal(media.streams.length, 1, "External clip audio must never be carried");
  assert.equal(video.length, 1);
  assert.equal(video[0].codec_name, "h264");
  assert.equal(video[0].width, 1280);
  assert.equal(video[0].height, 720);
  assert.equal(Number(video[0].nb_frames), span.durationFrames);
  assert.ok(Math.abs(Number(media.format.duration) - span.durationFrames / FPS) < 0.08);
  return output;
}


/**
 * After one short moving insert, preserve the original beat's static graphic
 * for exactly the remaining narrated frames. Fade back from the cinematic
 * dip-to-dark; never hold or replay the last motion-video frame.
 */
export async function encodeGraphicTail({imagePath, output, frames}) {
  assert.ok(isAbsolute(imagePath) && isAbsolute(output));
  assert.ok(Number.isSafeInteger(frames) && frames >= FPS &&
    frames < FPS * 240, "Invalid graphic-tail frame budget");
  const info = await lstat(imagePath);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  command("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-filter_complex_threads", "1", "-threads", "1",
    "-loop", "1", "-framerate", String(FPS),
    "-protocol_whitelist", "file,pipe", "-i", imagePath,
    "-vf", "format=yuv420p,fade=t=in:st=0:d=" + (10 / FPS).toFixed(6),
    "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
    "-threads:v", "1", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-an", "-movflags", "+faststart", output,
  ], 360000);
  const result = probe(output);
  assert.equal(result.streams.length, 1, "Graphic tail must never add an audio track");
  assert.equal(result.streams[0].codec_name, "h264");
  assert.equal(result.streams[0].width, 1280);
  assert.equal(result.streams[0].height, 720);
  assert.equal(Number(result.streams[0].nb_frames), frames);
  assert.ok(Math.abs(Number(result.format.duration) - frames / FPS) < 0.08);
  return output;
}
