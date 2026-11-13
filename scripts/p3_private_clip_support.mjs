#!/usr/bin/env node
/**
 * Optional reviewed local video clips for the private P3 ozone preview.
 * No downloads, no publication, and no implicit license granting.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateEpisodeMediaManifest } from './check_episode_media_manifest.mjs';

const FPS = 24;
const SOURCE_CODECS = new Set(['h264']);
const MAX_MANIFEST_BYTES = 256 * 1024;
const EXPECTED_SCENES = 19;

function run(command, args, timeout = 120000) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: 'utf8',
    timeout,
    maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  if (result.error || result.status !== 0) {
    throw new Error('P3_CLIP_COMMAND_FAILED: ' + command +
      '; status=' + String(result.status) +
      '; error=' + String(result.error?.code ?? 'none') +
      '; stderr=' + (result.stderr ?? '').slice(-900));
  }
  return result.stdout;
}

function probe(path) {
  return JSON.parse(run('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,nb_frames',
    '-of', 'json', path,
  ], 15000));
}

export function svgEscape(input) {
  return String(input).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** Preserve the private watermark when displaying actual moving footage. */
export function createPrivateClipOverlaySvg({title, credit, captureDate}) {
  for (const value of [title, credit, captureDate]) {
    assert.ok(typeof value === 'string' && value.trim() && !/[\r\n]/.test(value),
      'Clip overlay metadata must be nonempty single lines');
  }
  assert.ok(title.length <= 76 && credit.length <= 108);
  assert.match(captureDate, /^\d{4}-\d{2}-\d{2}$/);
  const headline = svgEscape(title);
  const provenance = svgEscape('SOURCE: ' + credit + '  |  RECORDED: ' + captureDate);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect x="0" y="0" width="1280" height="145" fill="#071420" fill-opacity="0.77"/>
    <rect x="0" y="586" width="1280" height="134" fill="#071420" fill-opacity="0.82"/>
    <rect x="74" y="50" width="9" height="70" fill="#64d8cb"/>
    <text x="103" y="95" fill="#ffffff" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="700">${headline}</text>
    <text x="78" y="635" fill="#c9dbe7" font-family="DejaVu Sans, sans-serif" font-size="18">${provenance}</text>
    <text x="78" y="676" fill="#ffbf9a" font-family="DejaVu Sans, sans-serif" font-size="19">PRIVATE PREVIEW - NOT FOR PUBLICATION</text>
  </svg>`;
}

/**
 * Validates the complete manifest, every clip and its eligible destination.
 * Clips must be long enough and are never looped or transferred to photo beats.
 */
export async function planPrivateClipAssignments({manifest, assetRoot, beatVisualAssets, beatFrames, beatTitles}) {
  assert.ok(Array.isArray(beatVisualAssets) && beatVisualAssets.length === EXPECTED_SCENES);
  assert.ok(Array.isArray(beatFrames) && beatFrames.length === EXPECTED_SCENES);
  assert.ok(Array.isArray(beatTitles) && beatTitles.length === EXPECTED_SCENES);
  const report = await validateEpisodeMediaManifest(manifest, assetRoot);
  assert.equal(report.assets, manifest.assets.length);
  const assignments = new Map();
  for (const asset of manifest.assets) {
    assert.equal(asset.kind, 'video', 'P3 clip override accepts reviewed video only');
    assert.ok(asset.path.endsWith('.mp4'), 'P3 clip override currently accepts local MP4 only');
    const match = /^beat-(\d{2})$/.exec(asset.sceneId);
    assert.ok(match, 'Use sceneId beat-01 through beat-19');
    const index = Number(match[1]) - 1;
    assert.ok(index >= 0 && index < EXPECTED_SCENES, 'Scene index out of range');
    assert.equal(beatVisualAssets[index], null,
      'Cannot replace a photo-backed scene or reuse a photo motif');
    assert.ok(!assignments.has(index), 'Duplicate scene assignment');
    assert.ok(Number.isSafeInteger(beatFrames[index]) && beatFrames[index] > 0);
    const meta = probe(asset.path);
    const tracks = meta.streams.filter(s => s.codec_type === 'video');
    assert.equal(tracks.length, 1, 'Expected exactly one video track');
    assert.ok(SOURCE_CODECS.has(tracks[0].codec_name), 'Source must be H264');
    assert.ok(tracks[0].width >= 640 && tracks[0].height >= 360,
      'Source video resolution below 640x360');
    const requiredDuration = beatFrames[index] / FPS;
    assert.ok(Number(meta.format.duration) >= requiredDuration + 0.1,
      'Do not loop or freeze clips: source must exceed scene duration');
    assignments.set(index, Object.freeze({
      path: asset.path, sha256: asset.sha256,
      title: beatTitles[index], credit: asset.credit, captureDate: asset.captureDate,
      sourceUrl: asset.sourceUrl, sceneId: asset.sceneId,
    }));
  }
  return assignments;
}

export async function loadPrivateClipAssignments({manifestPath, beatVisualAssets, beatFrames, beatTitles}) {
  assert.ok(typeof manifestPath === 'string' && isAbsolute(manifestPath),
    'Manifest path must be absolute');
  const info = await lstat(manifestPath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size < MAX_MANIFEST_BYTES,
    'Private manifest must be a small regular file');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(typeof manifest.assetRoot === 'string' && isAbsolute(manifest.assetRoot));
  return planPrivateClipAssignments({
    manifest, assetRoot: manifest.assetRoot, beatVisualAssets, beatFrames, beatTitles,
  });
}

/** Recheck bytes at use-time; no unverified path may enter ffmpeg. */
export async function encodePrivateClipBeat({assignment, overlayPng, output, frames}) {
  assert.ok(Number.isSafeInteger(frames) && frames >= 24 && frames <= 24 * 240);
  assert.ok(isAbsolute(assignment.path) && isAbsolute(overlayPng) && isAbsolute(output));
  assert.match(assignment.sha256, /^[a-f0-9]{64}$/);
  const digest = createHash('sha256').update(await readFile(assignment.path)).digest('hex');
  assert.equal(digest, assignment.sha256, 'Clip changed after manifest validation');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-threads', '1', '-filter_complex_threads', '1',
    '-protocol_whitelist', 'file,pipe', '-i', assignment.path,
    '-protocol_whitelist', 'file,pipe', '-i', overlayPng,
    '-filter_complex',
    '[0:v:0]fps=24,scale=1280:720:force_original_aspect_ratio=increase,' +
      'crop=1280:720,setsar=1,format=rgba[base];' +
      '[1:v]format=rgba[fg];' +
      '[base][fg]overlay=0:0:format=auto,format=yuv420p[outv]',
    '-map', '[outv]', '-frames:v', String(frames),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
    '-threads:v', '1', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-an', '-movflags', '+faststart', output,
  ], 360000);
  const info = probe(output);
  const video = info.streams.filter(stream => stream.codec_type === 'video');
  assert.equal(video.length, 1);
  assert.equal(video[0].codec_name, 'h264');
  assert.equal(video[0].width, 1280);
  assert.equal(video[0].height, 720);
  assert.equal(Number(video[0].nb_frames), frames);
  assert.ok(Math.abs(Number(info.format.duration) - frames / FPS) < 0.1);
  return output;
}
