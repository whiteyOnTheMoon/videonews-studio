#!/usr/bin/env node
/**
 * Read-only, offline preflight for episode photo/video assets.
 * Never downloads, publishes, modifies files, or grants rights.
 * Usage: node scripts/check_episode_media_manifest.mjs <manifest.json>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve, extname } from "node:path";

const SHA = /^[a-f0-9]{64}$/;
const ALLOWED = Object.freeze({
  photo: new Set([".jpg", ".jpeg", ".png"]),
  video: new Set([".mp4", ".mov", ".webm"]),
});
const REQUIRED = ["id", "kind", "path", "sha256", "sourceUrl",
  "creator", "credit", "licenseUrl", "licenseEvidence",
  "rightsReviewedBy", "rightsReviewedAt", "captureDate", "sceneId"];

function validHttps(raw) {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
  } catch { return false; }
}
function fail(message) { throw new Error("MEDIA_PREFLIGHT_DENIED: " + message); }
export async function validateEpisodeMediaManifest(manifest, root) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets))
    fail("Invalid schemaVersion or assets");
  if (!isAbsolute(root)) fail("Asset root must be absolute");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("Unsafe asset root");
  const canonicalRoot = await realpath(root);
  const seenIds = new Set(), seenSceneIds = new Set(), seenHashes = new Set();
  const seenPaths = new Set(), seenMotifs = new Set();
  const report = [];
  for (const [index, asset] of manifest.assets.entries()) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset))
      fail("Invalid asset at index " + index);
    for (const field of REQUIRED)
      if (typeof asset[field] !== "string" || !asset[field].trim())
        fail("Missing " + field + " at asset " + index);
    if (asset.rightsApproved !== true || asset.editorialApproved !== true)
      fail("Unapproved media: " + asset.id);
    if (asset.thirdPartyRightsCleared !== true)
      fail("Third-party rights not cleared: " + asset.id);
    if (asset.kind !== "photo" && asset.kind !== "video")
      fail("Invalid kind: " + asset.id);
    if (!ALLOWED[asset.kind].has(extname(asset.path).toLowerCase()))
      fail("Unsupported extension: " + asset.id);
    if (!SHA.test(asset.sha256)) fail("Invalid SHA-256: " + asset.id);
    if (!validHttps(asset.sourceUrl) || !validHttps(asset.licenseUrl))
      fail("Invalid source or license URL: " + asset.id);
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(asset.captureDate) ||
        !/^\\d{4}-\\d{2}-\\d{2}$/.test(asset.rightsReviewedAt) ||
        !Number.isFinite(Date.parse(asset.captureDate)) ||
        !Number.isFinite(Date.parse(asset.rightsReviewedAt)))
      fail("Invalid capture/review date: " + asset.id);
    if (typeof asset.motifId !== "string" || !asset.motifId.trim())
      fail("Missing motifId (cannot detect derivatives): " + asset.id);
    for (const [value, set, label] of [
      [asset.id, seenIds, "id"], [asset.sceneId, seenSceneIds, "scene"],
      [asset.sha256, seenHashes, "SHA"], [asset.motifId, seenMotifs, "motif"],
    ]) {
      if (set.has(value)) fail("Repeated " + label + ": " + value);
      set.add(value);
    }
    if (!isAbsolute(asset.path)) fail("Asset path is not absolute: " + asset.id);
    const path = resolve(asset.path);
    if (!path.startsWith(canonicalRoot + "/"))
      fail("Asset escapes approved root: " + asset.id);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      fail("Unsafe asset file: " + asset.id);
    const actual = await realpath(path);
    if (!actual.startsWith(canonicalRoot + "/") || seenPaths.has(actual))
      fail("Repeated or unsafe file path: " + asset.id);
    seenPaths.add(actual);
    const raw = await readFile(actual);
    if (!raw.length || raw.length > 300 * 1024 * 1024)
      fail("Invalid asset file size: " + asset.id);
    if (createHash("sha256").update(raw).digest("hex") !== asset.sha256)
      fail("Digest mismatch: " + asset.id);
    report.push({id: asset.id, kind: asset.kind, sceneId: asset.sceneId});
  }
  if (!report.length) fail("No validated media");
  return {status: "LOCAL_MEDIA_PREFLIGHT_PASS", assets: report.length,
    photos: report.filter(a => a.kind === "photo").length,
    videos: report.filter(a => a.kind === "video").length,
    note: "Hash and manifest preflight only; not a copyright or perceptual-similarity certification."};
}

const executed = process.argv[1] && import.meta.url === new URL("file://" + resolve(process.argv[1])).href;
if (executed) {
  if (process.argv.length !== 3) fail("Usage: node scripts/check_episode_media_manifest.mjs <manifest.json>");
  const manifestPath = resolve(process.argv[2]);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const root = manifest.assetRoot;
  assert.ok(typeof root === "string");
  console.log(JSON.stringify(await validateEpisodeMediaManifest(manifest, root), null, 2));
}
