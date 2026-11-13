#!/usr/bin/env node
/**
 * P3-14: offline, bounded perceptual comparison of hash-pinned local assets.
 * A dHash match is a REVIEW HINT, never proof of identity, rights or meaning.
 * No network, no automatic rights approvals, no deletion or publication.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {lstat, readFile} from "node:fs/promises";
import {extname, isAbsolute, resolve} from "node:path";

const SHA = /^[a-f0-9]{64}$/;
const TYPES = new Set([".mp4", ".jpg", ".jpeg", ".png"]);
const MAX_SOURCE = 48 * 1024 * 1024;
const MAX_ASSETS = 120;
const FRAME_LENGTH = 9 * 8;

function safeCommand(command, args, timeout = 18000) {
  const r = spawnSync(command, args, {
    shell: false, timeout, encoding: null, maxBuffer: 256 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  if (r.error || r.status !== 0) {
    throw new Error("VISUAL_FINGERPRINT_TOOL_FAILED: " + command +
      " status=" + String(r.status) +
      " error=" + String(r.error?.code ?? "none") +
      " stderr=" + (r.stderr?.toString("utf8") ?? "").slice(-300));
  }
  return r.stdout;
}

export function fingerprintGrayscale9x8(frame) {
  assert.ok(Buffer.isBuffer(frame) && frame.length === FRAME_LENGTH,
    "Expected exactly 72 grayscale pixels");
  let hash = 0n;
  let sum = 0, squared = 0;
  for (let i = 0; i < frame.length; i++) {
    const value = frame[i];
    sum += value;
    squared += value * value;
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash <<= 1n;
      if (frame[y * 9 + x] > frame[y * 9 + x + 1]) hash |= 1n;
    }
  }
  const mean = sum / FRAME_LENGTH;
  const deviation = Math.sqrt(Math.max(0, squared / FRAME_LENGTH - mean * mean));
  return Object.freeze({
    dhash: hash.toString(16).padStart(16, "0"),
    mean: Math.round(mean),
    contrast: Math.round(deviation),
    // Large blank areas give unreliable dHashes; do not equate flat frames.
    reliable: deviation >= 12,
  });
}

export function dhashDistance(a, b) {
  assert.match(a, /^[a-f0-9]{16}$/);
  assert.match(b, /^[a-f0-9]{16}$/);
  let different = BigInt("0x" + a) ^ BigInt("0x" + b);
  let distance = 0;
  while (different > 0n) {
    distance++;
    different &= different - 1n;
  }
  return distance;
}

function inspectVideoDuration(file) {
  const json = JSON.parse(safeCommand("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file,pipe",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json", file,
  ], 15000).toString("utf8"));
  assert.equal(json.streams?.filter(s => s.codec_type === "video").length, 1,
    "Expected exactly one video stream");
  const duration = Number(json.format?.duration);
  assert.ok(Number.isFinite(duration) && duration >= 0.25 && duration <= 900,
    "Video duration outside fingerprint limits");
  return duration;
}

function decode9x8(file, second) {
  const image = safeCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-threads", "1", "-filter_threads", "1",
    "-ss", second.toFixed(4),
    "-protocol_whitelist", "file,pipe", "-i", file,
    "-vf", "scale=9:8:flags=bilinear,format=gray",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], 20000);
  assert.equal(image.length, FRAME_LENGTH,
    "Source did not produce exactly one bounded visual sample");
  return fingerprintGrayscale9x8(image);
}

/** Used only after quarantine source was validated and checksum pinned. */
export async function fingerprintPrivateMedia({file, sha256, candidateId, sceneId}) {
  assert.ok(typeof file === "string" && isAbsolute(file) &&
    resolve(file) === file && TYPES.has(extname(file).toLowerCase()));
  assert.match(sha256, SHA);
  assert.ok(typeof candidateId === "string" && candidateId.length <= 140);
  assert.match(sceneId, /^beat-(0[1-9]|1[0-9])$/);
  const meta = await lstat(file);
  assert.ok(meta.isFile() && !meta.isSymbolicLink() &&
    meta.size > 32 && meta.size <= MAX_SOURCE);
  const bytes = await readFile(file);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    sha256, "Fingerprint source SHA differs from reviewed quarantine record");
  const isVideo = extname(file).toLowerCase() === ".mp4";
  const timestamps = isVideo ?
    (() => {
      const duration = inspectVideoDuration(file);
      // Three frames across a video; do not conflate a whole film with its poster.
      return [0.15, duration * 0.5, duration * 0.85]
        .map(s => Math.min(s, duration - 0.08));
    })() : [0];
  const samples = timestamps.map(time => decode9x8(file, time));
  return Object.freeze({
    candidateId, sceneId, sha256, mediaType: isVideo ? "video" : "photo",
    algorithm: "DHASH_9X8_GRAY_WITH_LUMINANCE_AND_CONTRAST_V1",
    samples,
  });
}

function closeSample(a, b, maxDistance) {
  if (!a.reliable || !b.reliable) return null;
  const distance = dhashDistance(a.dhash, b.dhash);
  if (distance > maxDistance ||
      Math.abs(a.mean - b.mean) > 12 ||
      Math.abs(a.contrast - b.contrast) > 12) return null;
  return distance;
}

export function inspectEpisodeVisualDuplicates(fingerprints) {
  assert.ok(Array.isArray(fingerprints) && fingerprints.length <= MAX_ASSETS,
    "At most 120 private candidate fingerprints");
  const byId = new Set();
  for (const f of fingerprints) {
    assert.ok(f && typeof f.candidateId === "string" &&
      f.candidateId.length > 0 && !byId.has(f.candidateId) &&
      /^beat-(0[1-9]|1[0-9])$/.test(f.sceneId) &&
      SHA.test(f.sha256) &&
      (f.mediaType === "video" || f.mediaType === "photo") &&
      Array.isArray(f.samples) && f.samples.length >= 1 && f.samples.length <= 3 &&
      f.samples.every(s =>
        typeof s.dhash === "string" && /^[a-f0-9]{16}$/.test(s.dhash) &&
        Number.isInteger(s.mean) && s.mean >= 0 && s.mean <= 255 &&
        Number.isInteger(s.contrast) && s.contrast >= 0 &&
        typeof s.reliable === "boolean"),
    "Malformed or repeated visual fingerprint record");
    byId.add(f.candidateId);
  }
  const pairs = [];
  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      const a = fingerprints[i], b = fingerprints[j];
      if (a.sha256 === b.sha256) {
        pairs.push({
          candidateA: a.candidateId, candidateB: b.candidateId,
          sceneA: a.sceneId, sceneB: b.sceneId,
          kind: "EXACT_FILE_DUPLICATE", minHamming: 0,
          matchedSamples: 0,
        });
        continue;
      }
      const bothVideos = a.mediaType === "video" && b.mediaType === "video";
      const maxDistance = bothVideos ? 4 : 3;
      const matches = [];
      for (const first of a.samples) {
        let best = null;
        for (const second of b.samples) {
          const d = closeSample(first, second, maxDistance);
          if (d !== null && (best === null || d < best)) best = d;
        }
        if (best !== null) matches.push(best);
      }
      const qualifying = bothVideos ? matches.length >= 2 :
        matches.length >= 1;
      if (qualifying) pairs.push({
        candidateA: a.candidateId, candidateB: b.candidateId,
        sceneA: a.sceneId, sceneB: b.sceneId,
        kind: "POSSIBLE_VISUAL_NEAR_DUPLICATE",
        minHamming: Math.min(...matches),
        matchedSamples: matches.length,
      });
    }
  }
  pairs.sort((a, b) =>
    a.candidateA.localeCompare(b.candidateA) ||
    a.candidateB.localeCompare(b.candidateB));
  return Object.freeze({
    algorithm: "CONSERVATIVE_DHASH_REVIEW_HINT_V1",
    inspectedSources: fingerprints.length,
    possiblePairs: pairs.length,
    pairs,
    sourceRightsApproved: false,
    automaticallyRejected: 0,
    publicationAllowed: false,
  });
}
