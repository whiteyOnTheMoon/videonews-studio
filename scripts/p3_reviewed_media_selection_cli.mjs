#!/usr/bin/env node
/**
 * P3-12 reviewed preview workflow (operator-controlled):
 *
 *   node scripts/p3_reviewed_media_selection_cli.mjs download
 *     <episode-library.json> <selection-consent.json> <private-workspace>
 *   node scripts/p3_reviewed_media_selection_cli.mjs prepare
 *     <episode-library.json> <human-reviews.json> <private-workspace>
 *
 * Download is quarantined and never an automatic renderer approval.
 * A separate human-reviewed manifest is only a private timeline input.
 */
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {lstat, readFile, realpath, rename, rm, writeFile} from "node:fs/promises";
import {basename, dirname, isAbsolute, join, resolve} from "node:path";
import {
  acquireQuarantinedMedia, buildReviewedPrivateClipManifest,
  planQuarantineDownloads,
} from "./p3_reviewed_media_selection.mjs";

async function readPrivateJson(file) {
  assert.ok(isAbsolute(file) && resolve(file) === file);
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() &&
    info.size > 2 && info.size < 512 * 1024 &&
    (info.mode & 0o077) === 0,
  "Input must be a private, small JSON file");
  return JSON.parse(await readFile(file, "utf8"));
}
async function assertWorkspace(workspace) {
  assert.ok(isAbsolute(workspace) && resolve(workspace) === workspace);
  const info = await lstat(workspace);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() &&
    (info.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || info.uid === process.getuid()));
  assert.equal(await realpath(workspace), workspace);
}
async function saveOnce(file, value) {
  // No in-place overwrite of operator evidence or previous acquisition records.
  const path = join(dirname(file), "." + basename(file) + "-" +
    randomBytes(6).toString("hex") + ".partial");
  try {
    await writeFile(path, JSON.stringify(value, null, 2) + "\n",
      {mode: 0o600, flag: "wx"});
    await lstat(file).then(() => {
      throw new Error("Output already exists: refuse to overwrite evidence");
    }, error => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(path, file);
  } finally {
    await rm(path, {force: true});
  }
}

export async function runReviewedMediaSelectionCli(args) {
  assert.ok(Array.isArray(args) && args.length === 4,
    "Usage: download|prepare <library.json> <consent-or-review.json> <workspace>");
  const [action, libraryPath, evidencePath, workspace] = args;
  assert.ok(action === "download" || action === "prepare");
  await assertWorkspace(workspace);
  const [libraryInput, evidence] = await Promise.all([
    readPrivateJson(libraryPath), readPrivateJson(evidencePath),
  ]);
  // P3-11 stores a checkpoint {library, handoff, ...}; P3-10 stores a
  // plain episode library. Both must retain blocked publication status.
  const library = libraryInput.library ?? libraryInput;
  assert.ok(library && library.schemaVersion === 1 &&
    library.publicationAllowed === false &&
    library.rightsStatus === "BLOCKED");
  if (action === "download") {
    assert.ok(evidence && evidence.schemaVersion === 1 &&
      Array.isArray(evidence.selections),
    "Explicit selected candidate IDs and consent required");
    const plan = planQuarantineDownloads({
      library, selections: evidence.selections,
      operatorConsent: evidence.operatorConsent,
    });
    const result = await acquireQuarantinedMedia({plan, workspace});
    await saveOnce(join(workspace, "quarantine-receipt.json"), {
      schemaVersion: 1, episodeId: library.episodeId,
      status: "QUARANTINE_ONLY_REQUIRES_REVIEW",
      rightsApproved: false, publicationAllowed: false,
      records: result.files,
    });
    return {
      status: result.status, episodeId: library.episodeId,
      downloadedFiles: result.files.length, bytes: result.bytes,
      receipt: join(workspace, "quarantine-receipt.json"),
      rightsApproved: false, publicationAllowed: false,
    };
  }
  assert.ok(evidence && evidence.schemaVersion === 1 &&
    evidence.episodeId === library.episodeId &&
    Array.isArray(evidence.reviews));
  const receipt = await readPrivateJson(join(workspace, "quarantine-receipt.json"));
  assert.equal(receipt.episodeId, library.episodeId);
  assert.equal(receipt.status, "QUARANTINE_ONLY_REQUIRES_REVIEW");
  const prepared = await buildReviewedPrivateClipManifest({
    library, quarantined: receipt.records, reviews: evidence.reviews,
    assetRoot: join(workspace, "quarantine"),
  });
  const output = join(workspace, "private-cinematic-manifest.json");
  await saveOnce(output, prepared.manifest);
  return {
    status: prepared.status,
    episodeId: library.episodeId, manifest: output,
    reviewedClips: prepared.manifest.assets.length,
    episodePublicationAllowed: false,
  };
}

if (process.argv[1] && import.meta.url ===
    new URL("file://" + resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await runReviewedMediaSelectionCli(process.argv.slice(2)),
    null, 2));
}
