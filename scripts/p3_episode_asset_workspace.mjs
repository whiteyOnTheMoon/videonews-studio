#!/usr/bin/env node
/**
 * Episode asset sandbox. Only locally reviewed media can be copied into a
 * temporary private cache. A verified private MP4 export is required before
 * removing that cache; the external provenance receipt survives.
 */
import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {constants as fsConstants} from "node:fs";
import {chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath,
  rename, rm, writeFile} from "node:fs/promises";
import {basename, dirname, extname, isAbsolute, join, resolve} from "node:path";

const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE = 150 * 1024 * 1024;
const ALLOWED_EXT = new Set([".mp4", ".jpg", ".jpeg", ".png", ".webm"]);
function inside(root, path) {
  return path.startsWith(root + "/");
}
async function checkDirectory(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path && path !== "/");
  const node = await lstat(path);
  assert.ok(node.isDirectory() && !node.isSymbolicLink(),
    "Working path must be a non-symlink directory");
  assert.equal((await realpath(path)), path,
    "Symlink ancestor paths are not permitted");
  assert.equal(node.mode & 0o077, 0, "Private asset directory needs mode 0700");
  if (typeof process.getuid === "function")
    assert.equal(node.uid, process.getuid(), "Private path has wrong owner");
}
function fileFingerprint(raw, ext) {
  const hex = raw.subarray(0, 12).toString("hex");
  if (ext === ".jpg" || ext === ".jpeg") assert.ok(hex.startsWith("ffd8ff"));
  if (ext === ".png") assert.ok(hex.startsWith("89504e470d0a1a0a"));
  if (ext === ".mp4") assert.equal(raw.subarray(4, 8).toString(), "ftyp");
  if (ext === ".webm") assert.ok(hex.startsWith("1a45dfa3"));
}
export async function createEpisodeAssetWorkspace({root, episodeId}) {
  assert.match(episodeId, /^[a-z0-9][a-z0-9-]{3,90}$/);
  await checkDirectory(root);
  const workspace = await mkdtemp(join(root, episodeId + "-"));
  await chmod(workspace, 0o700);
  await checkDirectory(workspace);
  await mkdir(join(workspace, "media"), {mode: 0o700});
  return workspace;
}

export async function stageReviewedLocalAsset({workspace, sourcePath, reviewed}) {
  await checkDirectory(workspace);
  assert.ok(reviewed && reviewed.rightsApproved === true &&
    reviewed.editorialApproved === true &&
    reviewed.thirdPartyRightsCleared === true,
  "Media must have explicit individual review approvals");
  assert.ok(typeof reviewed.sourcePage === "string" &&
    reviewed.sourcePage.startsWith("https://") &&
    typeof reviewed.licenseEvidence === "string" &&
    reviewed.licenseEvidence.length > 12 &&
    typeof reviewed.reviewedBy === "string" && reviewed.reviewedBy.trim(),
  "Reviewer/source/license evidence required");
  assert.match(reviewed.sha256, SHA);
  assert.ok(isAbsolute(sourcePath) && resolve(sourcePath) === sourcePath &&
    !inside(workspace, sourcePath), "Source must be an absolute external local file");
  const metadata = await lstat(sourcePath);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() &&
    metadata.size > 16 && metadata.size <= MAX_FILE,
  "Invalid or unsafe source file");
  const ext = extname(sourcePath).toLowerCase();
  assert.ok(ALLOWED_EXT.has(ext), "Unsupported photo/video file extension");
  const raw = await readFile(sourcePath);
  fileFingerprint(raw, ext);
  const digest = createHash("sha256").update(raw).digest("hex");
  assert.equal(digest, reviewed.sha256, "Reviewed hash does not match local media");
  const target = join(workspace, "media", digest + ext);
  const canonical = await realpath(join(workspace, "media"));
  assert.equal(canonical, join(workspace, "media"));
  await copyFile(sourcePath, target, fsConstants.COPYFILE_EXCL);
  await chmod(target, 0o600);
  const copied = await readFile(target);
  assert.equal(createHash("sha256").update(copied).digest("hex"), digest);
  return Object.freeze({
    sceneId: reviewed.sceneId, provider: reviewed.provider,
    sourcePage: reviewed.sourcePage, licensePage: reviewed.licensePage,
    licenseEvidence: reviewed.licenseEvidence,
    reviewedBy: reviewed.reviewedBy, sha256: digest,
    localPath: target, bytes: copied.length,
    status: "REVIEWED_LOCAL_COPY_NOT_PUBLISHED",
  });
}

export async function finalizePrivateExportAndCleanup({
  workspace, root, library, privateExportPath, expectedExportSha256,
  receiptPath, explicitCleanupApproved,
}) {
  assert.equal(explicitCleanupApproved, true,
    "Never delete an episode's temporary assets without explicit approval");
  await checkDirectory(root);
  await checkDirectory(workspace);
  assert.equal(dirname(workspace), root, "Only an immediate child workspace may be deleted");
  assert.match(basename(workspace), /^[a-z0-9][a-z0-9-]{3,90}-[a-zA-Z0-9]{6}$/);
  assert.ok(isAbsolute(privateExportPath) &&
    resolve(privateExportPath) === privateExportPath &&
    !inside(workspace, privateExportPath));
  assert.match(expectedExportSha256, SHA);
  const mp4 = await lstat(privateExportPath);
  assert.ok(mp4.isFile() && !mp4.isSymbolicLink() &&
    extname(privateExportPath) === ".mp4" &&
    mp4.size > 1024, "A real finished private MP4 is required");
  const digest = createHash("sha256")
    .update(await readFile(privateExportPath)).digest("hex");
  assert.equal(digest, expectedExportSha256,
    "Export checksum mismatch; temporary assets retained");
  assert.ok(library && library.schemaVersion === 1 &&
    Array.isArray(library.candidates) &&
    Array.isArray(library.searchPlan));
  assert.ok(isAbsolute(receiptPath) && resolve(receiptPath) === receiptPath &&
    !inside(workspace, receiptPath) &&
    !inside(root, receiptPath) &&
    receiptPath !== privateExportPath,
    "The receipt must be outside the temporary asset tree");
  const receiptParent = dirname(receiptPath);
  await checkDirectory(receiptParent);
  const receipt = {
    schemaVersion: 1, episodeId: library.episodeId,
    sourceStoryAsOf: library.sourceStoryAsOf,
    export: {path: privateExportPath, sha256: digest, bytes: mp4.size},
    rightsStatus: library.rightsStatus,
    publicationAllowed: false,
    candidates: library.candidates.map(item => ({
      id: item.id, sceneId: item.sceneId, provider: item.provider,
      sourcePage: item.sourcePage, licensePage: item.licensePage,
      creator: item.creator, credit: item.credit,
      reviewStatus: item.reviewStatus, selection: item.selection,
    })),
    searchPlan: library.searchPlan,
    stagedAssets: (library.mediaFiles ?? []).map(item => ({
      sha256: item.sha256, sourcePage: item.sourcePage, sceneId: item.sceneId,
      licensePage: item.licensePage, reviewedBy: item.reviewedBy,
    })),
    cachePurged: true,
  };
  const tmp = join(receiptParent, "." + basename(receiptPath) +
    ".partial-" + randomBytes(4).toString("hex"));
  try {
    await writeFile(tmp, JSON.stringify(receipt, null, 2) + "\n",
      {mode: 0o600, flag: "wx"});
    await rename(tmp, receiptPath);
  } catch (error) {
    await rm(tmp, {force: true});
    throw error;
  }
  // Do not follow symlinked cache entries. A malicious child must fail closed
  // after its provenance receipt is safely written.
  const staged = join(workspace, "media");
  await checkDirectory(staged);
  await rm(workspace, {recursive: true, force: false});
  return {status: "PRIVATE_EXPORT_VERIFIED_CACHE_PURGED",
    retainedReceipt: receiptPath, exportSha256: digest};
}
