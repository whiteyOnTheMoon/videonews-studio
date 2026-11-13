#!/usr/bin/env node
/**
 * P3-17: layered full-bleed moving-news composition.
 *
 * Offline only. Approved sources already exist on the private filesystem.
 * A background is atmospheric and may be obscured by a translucent gradient
 * and changing foreground. Science source content is presented as a separate,
 * complete-frame video inset, never unreviewed full-bleed "data wallpaper".
 * All data stays in 24fps integer frames and source audio is discarded.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {lstat, mkdir, readFile, writeFile} from "node:fs/promises";
import {isAbsolute, join} from "node:path";
import {validateEpisodeMediaManifest} from "./check_episode_media_manifest.mjs";
import {requiresScienceSafeMode} from "./p3_science_safe_composition.mjs";

export const LAYERED_FPS = 24;
export const LAYERED_FADE_FRAMES = 12;
const HALF_FADE = LAYERED_FADE_FRAMES / 2;
const SCENE_LIMIT = 19;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MEDIA_WIDTH = 448;
const MEDIA_HEIGHT = 252;
const MEDIA_X = 765;
const MEDIA_Y = 242;

function run(name, args, timeout = 360000) {
  const r = spawnSync(name, args, {
    shell: false, encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  if (r.error || r.status !== 0) {
    throw new Error("LAYERED_COMMAND_FAILED " + name + " status=" + r.status +
      " code=" + (r.error?.code ?? "none") + " stderr=" + (r.stderr ?? "").slice(-1400));
  }
  return r.stdout;
}

function probe(file) {
  return JSON.parse(run("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file,pipe",
    "-show_entries", "format=duration:stream=codec_name,codec_type,width,height,nb_frames",
    "-of", "json", file,
  ], 15000));
}

function beatIndex(raw, length) {
  const match = /^beat-(0[1-9]|1[0-9])$/.exec(raw ?? "");
  assert.ok(match, "Layered sceneId must be beat-01 through beat-19");
  const index = Number(match[1]) - 1;
  assert.ok(index < length, "Layered scene lies outside the narrated sequence");
  return index;
}

function duration(frames) {
  return (frames / LAYERED_FPS).toFixed(6);
}

function escaping(value) {
  return String(value).replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function wrap(text, limit, maxLines) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const result = [];
  let line = "";
  for (const raw of words) {
    const word = raw.length > limit ? raw.slice(0, limit - 1) + "…" : raw;
    if (line && line.length + 1 + word.length > limit) {
      result.push(line);
      line = "";
    }
    if (result.length >= maxLines) break;
    line += (line ? " " : "") + word;
  }
  if (line && result.length < maxLines) result.push(line);
  return result;
}

function label(x, y, value, size = 22, color = "#f1f8fd", weight = 400) {
  return '<text x="' + x + '" y="' + y + '" fill="' + color +
    '" font-family="DejaVu Sans,sans-serif" font-weight="' + weight +
    '" font-size="' + size + '">' + escaping(value) + "</text>";
}

export function createLayeredDimSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<defs>',
    '<linearGradient id="gradient" x1="0" y1="0" x2="1" y2="0">',
    '<stop offset="0%" stop-color="#04101f" stop-opacity="0.78"/>',
    '<stop offset="48%" stop-color="#083447" stop-opacity="0.45"/>',
    '<stop offset="100%" stop-color="#061221" stop-opacity="0.32"/>',
    '</linearGradient>',
    '<linearGradient id="bottom" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0%" stop-color="#061321" stop-opacity="0"/>',
    '<stop offset="100%" stop-color="#040b18" stop-opacity="0.47"/>',
    '</linearGradient></defs>',
    '<rect width="1280" height="720" fill="url(#gradient)"/>',
    '<rect width="1280" height="720" fill="url(#bottom)"/>',
    '</svg>',
  ].join("");
}

/** All science-image pixels stay within their frame, above the dim layer. */
export function createLayeredForegroundSvg({visual, sequence, backgroundCredit, foreground}) {
  assert.ok(visual && typeof visual.title === "string" &&
    visual.title.length >= 3 && visual.title.length <= 85);
  assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= SCENE_LIMIT);
  const hasMedia = Boolean(foreground);
  const rows = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">',
    '<defs><clipPath id="headline"><rect x="66" y="115" width="' +
      (hasMedia ? "634" : "1080") + '" height="416"/></clipPath></defs>',
    '<rect x="65" y="70" width="6" height="31" rx="3" fill="#6be5d3"/>',
    label(89, 92, "EARTH / CLIMATE  •  EXPLAINED", 18, "#a3f8ea", 700),
    '<g clip-path="url(#headline)">',
  ];
  const width = hasMedia ? 29 : 38;
  wrap(visual.title, width, 3).forEach((line, i) =>
    rows.push(label(68, 172 + 52 * i, line, hasMedia ? 36 : 42, "#ffffff", 700)));
  const body = typeof visual.body === "string" ? visual.body :
    Array.isArray(visual.entries) ? visual.entries.map(x => x.label ?? "").join(" · ") : "";
  if (visual.kind === "chart" && Array.isArray(visual.bars)) {
    const bars = visual.bars.slice(0, 3);
    const max = Math.max(1, ...bars.map(item => Number(item.value) || 0));
    bars.forEach((item, i) => {
      const value = Number(item.value);
      assert.ok(Number.isFinite(value) && value >= 0);
      const y = 389 + i * 60;
      rows.push(label(76, y, String(item.label ?? "").slice(0, 34), 18));
      rows.push('<rect x="76" y="' + (y + 12) +
        '" width="' + (hasMedia ? 450 : 750) +
        '" height="10" rx="4" fill="#d8f8f0" fill-opacity=".20"/>');
      rows.push('<rect x="76" y="' + (y + 12) +
        '" width="' + Math.round((hasMedia ? 450 : 750) * value / max) +
        '" height="10" rx="4" fill="#68ddce"/>');
    });
  } else {
    wrap(body, hasMedia ? 46 : 72, 3).forEach((line, i) =>
      rows.push(label(76, 392 + 32 * i, line, 21, "#dceef5")));
  }
  rows.push("</g>");
  if (hasMedia) {
    rows.push('<rect x="748" y="224" width="482" height="289" rx="12" ' +
      'fill="none" stroke="#72dfd3" ' +
      'stroke-opacity=".90" stroke-width="2"/>');
    rows.push(label(769, 215,
      foreground.role === "science-inset" ? "SCIENTIFIC VISUALIZATION" : "SOURCE IMAGE",
      16, "#aefff0", 700));
    rows.push(label(768, 536, foreground.credit.slice(0, 65), 16, "#ffffff"));
  } else {
    rows.push('<path d="M785 345 Q980 225 1150 365" fill="none" ' +
      'stroke="#6be5d3" stroke-opacity=".52" stroke-width="5"/>');
    rows.push('<circle cx="970" cy="292" r="80" fill="#6be5d3" fill-opacity=".06" ' +
      'stroke="#6be5d3" stroke-opacity=".29" stroke-width="3"/>');
  }
  rows.push('<rect x="65" y="632" width="1150" height="1" fill="#b2f2ed" fill-opacity=".3"/>');
  rows.push(label(68, 668, "BACKGROUND: " + backgroundCredit.slice(0, 70), 15, "#d0e5eb"));
  rows.push(label(1136, 668, String(sequence).padStart(2, "0") + " / 19", 15,
    "#a9e8df", 700));
  rows.push("</svg>");
  return rows.join("");
}

export function createLayeredPreviewBrandSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">',
    '<rect x="930" y="18" width="288" height="32" rx="8" ' +
      'fill="#06101d" fill-opacity=".72"/>',
    label(947, 40, "PRIVATE TEST • NO PUBLICATION", 15, "#ffcfb7", 700),
    '</svg>',
  ].join("");
}

/**
 * Each background is editorially allocated whole beats. At a cut, the
 * adjacent sources BOTH contribute six extra frames; xfade consumes their
 * 12-frame overlap. Total output remains exactly sum(beatFrames).
 * Source audio is always ignored.
 */
export async function planLayeredTimeline({manifest, assetRoot, beatFrames, beatVisuals}) {
  assert.ok(Array.isArray(beatFrames) && beatFrames.length >= 2 &&
    beatFrames.length <= SCENE_LIMIT, "Layered needs 2-19 scenes");
  assert.ok(Array.isArray(beatVisuals) && beatVisuals.length === beatFrames.length);
  for (const frames of beatFrames) assert.ok(
    Number.isSafeInteger(frames) && frames >= 48 && frames <= 24 * 180,
    "Layered beat requires >=2s and <=180s");
  const timelineFrames = beatFrames.reduce((sum, n) => sum + n, 0);
  assert.ok(timelineFrames <= 24 * 610, "Layered timeline too long");
  const checked = await validateEpisodeMediaManifest(manifest, assetRoot);
  assert.equal(checked.assets, manifest.assets.length);
  assert.ok(manifest.assets.length <= 30, "Layered asset count exceeds 30");

  const backgrounds = [], foreground = [], occupied = new Array(beatFrames.length).fill(null);
  for (const asset of manifest.assets) {
    assert.ok(["background", "science-inset", "image-card"].includes(asset.role),
      "Layered asset requires reviewed role");
    const start = beatIndex(asset.sceneId, beatFrames.length);
    const end = beatIndex(asset.endSceneId, beatFrames.length);
    assert.ok(end >= start, "Layered asset has inverted scene range");
    assert.ok(asset.compositionMode === "layered-cinematic",
      "Layered asset requires explicit compositionMode");
    assert.ok(!Object.hasOwn(asset, "scientificVisualization") ||
      typeof asset.scientificVisualization === "boolean",
    "scientificVisualization must be boolean");
    const frames = beatFrames.slice(start, end + 1).reduce((sum, n) => sum + n, 0);
    if (asset.role === "background") {
      assert.equal(asset.kind, "video", "Background must be video");
      assert.ok(!requiresScienceSafeMode(asset),
        "Annotated scientific footage must be a separate foreground inset");
      assert.ok(start <= end, "Invalid background range");
      for (let index = start; index <= end; index++) {
        assert.equal(occupied[index], null, "Layered background spans overlap");
        occupied[index] = asset.id;
      }
    } else {
      if (asset.role === "science-inset") assert.equal(asset.kind, "video",
        "Scientific inset must be video");
      else assert.equal(asset.kind, "photo", "Image card must be a photo");
      for (const other of foreground) assert.ok(end < other.start || start > other.end,
        "Layered foreground media must not overlap");
      assert.ok(foreground.length < 6, "Too many layered media insets");
    }
    if (asset.kind === "video") {
      assert.ok(asset.path.endsWith(".mp4"), "Only H264 MP4 video supported");
      const metadata = probe(asset.path);
      const videos = metadata.streams.filter(x => x.codec_type === "video");
      assert.equal(videos.length, 1, "One video stream required");
      assert.equal(videos[0].codec_name, "h264");
      assert.ok(videos[0].width >= 640 && videos[0].height >= 360);
      assert.ok(Number.isFinite(Number(metadata.format.duration)));
    }
    const record = {...asset, start, end, assignedFrames: frames};
    (asset.role === "background" ? backgrounds : foreground).push(record);
  }
  assert.ok(occupied.every(id => id !== null),
    "Layered background must cover every narrated beat");
  backgrounds.sort((a, b) => a.start - b.start);
  assert.ok(backgrounds.length >= 1 && backgrounds.length <= SCENE_LIMIT);
  for (let i = 0; i < backgrounds.length; i++) {
    const asset = backgrounds[i];
    assert.equal(asset.start, i === 0 ? 0 : backgrounds[i - 1].end + 1,
      "Layered background spans require consecutive nonoverlapping scene ranges");
    const preceding = i > 0 ? HALF_FADE : 0;
    const following = i + 1 < backgrounds.length ? HALF_FADE : 0;
    asset.sourceFrames = asset.assignedFrames + preceding + following;
  }
  assert.equal(backgrounds.at(-1).end, beatFrames.length - 1);
  for (const asset of [...backgrounds, ...foreground]) {
    if (asset.kind === "video") {
      const metadata = probe(asset.path);
      const required = asset.role === "background"
        ? asset.sourceFrames : asset.assignedFrames;
      assert.ok(Number(metadata.format.duration) >= required / LAYERED_FPS + 0.1,
        "Layered source too short: no looping, freezing or stretching");
    }
  }
  const starts = [0];
  for (const count of beatFrames.slice(0, -1))
    starts.push(starts.at(-1) + count);
  return {backgrounds, foreground, starts, beatFrames, beatVisuals, timelineFrames};
}

export async function loadLayeredTimeline({manifestPath, beatFrames, beatVisuals}) {
  assert.ok(typeof manifestPath === "string" && isAbsolute(manifestPath),
    "Private absolute layered manifest path required");
  const info = await lstat(manifestPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() &&
    info.size > 2 && info.size <= MAX_MANIFEST_BYTES);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(typeof manifest.assetRoot === "string" && isAbsolute(manifest.assetRoot));
  return planLayeredTimeline({
    manifest, assetRoot: manifest.assetRoot, beatFrames, beatVisuals,
  });
}

async function pngFromSvg(directory, name, svgContent) {
  const svg = join(directory, name + ".svg");
  const png = join(directory, name + ".png");
  await writeFile(svg, svgContent, {mode: 0o600, flag: "wx"});
  run("rsvg-convert", ["--output", png, svg], 30000);
  return png;
}

async function assertUnchanged(files) {
  for (const source of files) {
    const sha = createHash("sha256").update(await readFile(source.path)).digest("hex");
    assert.equal(sha, source.sha256, "Layered source changed after rights preflight");
  }
}

/** Source video only. Narration stays independent and is muxed by the caller. */
export async function encodeLayeredSequence({plan, output, directory}) {
  assert.ok(isAbsolute(output) && isAbsolute(directory));
  assert.ok(plan && Array.isArray(plan.backgrounds) &&
    plan.backgrounds.length >= 1 && Array.isArray(plan.foreground));
  await assertUnchanged([...plan.backgrounds, ...plan.foreground]);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const foregroundFiles = [];
  const beatOwners = plan.beatFrames.map((_, i) =>
    plan.backgrounds.find(asset => asset.start <= i && asset.end >= i));
  for (let i = 0; i < plan.beatFrames.length; i++) {
    const asset = plan.foreground.find(a => a.start <= i && a.end >= i);
    foregroundFiles.push(await pngFromSvg(directory, "layered-foreground-" + (i + 1),
      createLayeredForegroundSvg({
        visual: plan.beatVisuals[i],
        sequence: i + 1,
        backgroundCredit: beatOwners[i].credit,
        foreground: asset,
      })));
  }
  const dimPath = await pngFromSvg(directory, "layered-dim", createLayeredDimSvg());
  const brandPath = await pngFromSvg(directory, "layered-brand", createLayeredPreviewBrandSvg());
  const sources = [...plan.backgrounds, ...plan.foreground];
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-threads", "1", "-filter_complex_threads", "1",
    ...sources.flatMap(a => a.kind === "photo"
      ? ["-loop", "1", "-framerate", String(LAYERED_FPS),
        "-protocol_whitelist", "file,pipe", "-i", a.path]
      : ["-protocol_whitelist", "file,pipe", "-i", a.path]),
    ...[dimPath, ...foregroundFiles, brandPath].flatMap(path =>
      ["-loop", "1", "-framerate", String(LAYERED_FPS),
        "-protocol_whitelist", "file,pipe", "-i", path]),
  ];
  const g = [];
  for (let i = 0; i < plan.backgrounds.length; i++) {
    const b = plan.backgrounds[i];
    g.push("[" + i + ":v:0]fps=24,trim=duration=" +
      duration(b.sourceFrames) +
      ",setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=increase," +
      "crop=1280:720,setsar=1,format=yuv420p[bg" + i + "]");
  }
  let last = "[bg0]", elapsed = 0;
  for (let i = 1; i < plan.backgrounds.length; i++) {
    elapsed += plan.backgrounds[i - 1].assignedFrames;
    const offsetFrames = elapsed - HALF_FADE;
    const current = "[cross" + i + "]";
    g.push(last + "[bg" + i + "]xfade=transition=fade:duration=" +
      duration(LAYERED_FADE_FRAMES) + ":offset=" +
      duration(offsetFrames) + current);
    last = current;
  }
  const dimIndex = sources.length;
  g.push(last + "[" + dimIndex + ":v]overlay=0:0:format=auto:" +
    "shortest=1[dimmed]");

  let previous = "[dimmed]";
  for (let i = 0; i < plan.foreground.length; i++) {
    const a = plan.foreground[i];
    const index = plan.backgrounds.length + i;
    const offset = plan.starts[a.start];
    const frames = a.assignedFrames;
    const fade = Math.min(10, Math.floor(frames / 4));
    const mediaTag = "[fg-media" + i + "]";
    g.push("[" + index + ":v:0]fps=24,trim=duration=" + duration(frames) +
      ",setpts=PTS-STARTPTS,scale=" + MEDIA_WIDTH + ":" + MEDIA_HEIGHT +
      ":force_original_aspect_ratio=decrease," +
      "pad=" + MEDIA_WIDTH + ":" + MEDIA_HEIGHT +
      ":(ow-iw)/2:(oh-ih)/2:color=0x06101c," +
      "setsar=1,format=rgba,fade=t=in:st=0:d=" + duration(fade) +
      ":alpha=1,fade=t=out:st=" + duration(frames - fade) +
      ":d=" + duration(fade) + ":alpha=1,setpts=PTS-STARTPTS+" +
      duration(offset) + "/TB" + mediaTag);
    const next = "[with-media" + i + "]";
    g.push(previous + mediaTag + "overlay=" + MEDIA_X + ":" + MEDIA_Y +
      ":format=auto:repeatlast=0:eof_action=pass:" +
      "enable='between(n," + offset + "," +
      (offset + frames - 1) + ")'" + next);
    previous = next;
  }

  for (let i = 0; i < plan.beatFrames.length; i++) {
    const frames = plan.beatFrames[i];
    const fade = Math.min(10, Math.floor(frames / 4));
    const offset = plan.starts[i];
    const index = dimIndex + 1 + i;
    const alpha = "[beat-layer" + i + "]";
    const next = "[frame" + i + "]";
    g.push("[" + index + ":v]fps=24,trim=duration=" + duration(frames) +
      ",setpts=PTS-STARTPTS,format=rgba," +
      "fade=t=in:st=0:d=" + duration(fade) + ":alpha=1," +
      "fade=t=out:st=" + duration(frames - fade) +
      ":d=" + duration(fade) + ":alpha=1,setpts=PTS-STARTPTS+" +
      duration(offset) + "/TB" + alpha);
    g.push(previous + alpha + "overlay=0:0:format=auto:" +
      "repeatlast=0:eof_action=pass:enable='between(n," +
      offset + "," + (offset + frames - 1) + ")'" + next);
    previous = next;
  }
  const brandIndex = dimIndex + plan.beatFrames.length + 1;
  g.push(previous + "[" + brandIndex +
    ":v]overlay=0:0:format=auto:shortest=0," +
    "format=yuv420p,trim=duration=" +
    duration(plan.timelineFrames) + "[outv]");

  run("ffmpeg", [
    ...args, "-filter_complex", g.join(";"), "-map", "[outv]",
    "-frames:v", String(plan.timelineFrames),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30",
    "-threads:v", "1", "-pix_fmt", "yuv420p",
    "-r", String(LAYERED_FPS), "-an", "-movflags", "+faststart", output,
  ]);
  const media = probe(output);
  assert.equal(media.streams.length, 1, "Source audio must never enter layered export");
  const video = media.streams[0];
  assert.equal(video.codec_type, "video");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 1280);
  assert.equal(video.height, 720);
  assert.equal(Number(video.nb_frames), plan.timelineFrames);
  assert.ok(Math.abs(Number(media.format.duration) - plan.timelineFrames / LAYERED_FPS) < 0.08);
  return output;
}
