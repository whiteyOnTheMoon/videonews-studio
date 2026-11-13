#!/usr/bin/env node
/**
 * P3-12 operator-selected, bounded media acquisition.
 * Explicitly quarantined: downloaded bytes are NEVER render-approved.
 * Only fixed NASA/Pexels hosts; no redirects, credentials or scraping.
 */
import assert from "node:assert/strict";
import {createHash, randomBytes} from "node:crypto";
import {constants as fsConstants} from "node:fs";
import {copyFile, lstat, mkdir, open, readFile, realpath, rm} from "node:fs/promises";
import {basename, dirname, extname, isAbsolute, join, resolve} from "node:path";
import {validateEpisodeMediaManifest} from "./check_episode_media_manifest.mjs";

const MAX_DOWNLOADS = 4;
const MAX_PER_SCENE = 2;
const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_BATCH_BYTES = 128 * 1024 * 1024;
const FILE_TYPES = Object.freeze({
  ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png",
});
const HOSTS = Object.freeze({
  nasa: new Set([
    "images-assets.nasa.gov", "svs.gsfc.nasa.gov",
    "ozonewatch.gsfc.nasa.gov",
  ]),
  pexels: new Set(["videos.pexels.com", "images.pexels.com"]),
});
const SHA = /^[a-f0-9]{64}$/;
function inside(root, file) {
  return file.startsWith(root + "/");
}
function requireHttpsUrl(raw, hosts) {
  assert.ok(typeof raw === "string" && raw.length <= 2000);
  const url = new URL(raw);
  assert.ok(url.protocol === "https:" && url.username === "" &&
    url.password === "" && url.port === "" && !url.hash &&
    !url.search && hosts.has(url.hostname) &&
    url.hostname === url.hostname.toLowerCase(),
  "Direct media URL is not on an approved provider CDN");
  const ext = extname(url.pathname).toLowerCase();
  assert.ok(Object.hasOwn(FILE_TYPES, ext), "Unsupported media file extension");
  return {url: url.href, ext};
}
function verifyMagic(bytes, ext) {
  assert.ok(bytes.length >= 32, "Empty or truncated media");
  const hex = bytes.subarray(0, 12).toString("hex");
  if (ext === ".jpg" || ext === ".jpeg") assert.ok(hex.startsWith("ffd8ff"));
  if (ext === ".png") assert.ok(hex.startsWith("89504e470d0a1a0a"));
  if (ext === ".mp4") assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
}
async function requirePrivateWorkspace(workspace) {
  assert.ok(typeof workspace === "string" &&
    isAbsolute(workspace) && resolve(workspace) === workspace &&
    workspace !== "/");
  const meta = await lstat(workspace);
  assert.ok(meta.isDirectory() && !meta.isSymbolicLink() &&
    (meta.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || meta.uid === process.getuid()),
  "Quarantine must be private and owned by current operator");
  assert.equal(await realpath(workspace), workspace,
    "Quarantine cannot have a symlink ancestor");
}
function allowCandidate(library, selection) {
  assert.ok(selection && typeof selection === "object");
  assert.ok(typeof selection.candidateId === "string");
  const candidate = library.candidates.find(item => item.id === selection.candidateId);
  assert.ok(candidate && candidate.sceneId === selection.sceneId,
    "Requested source must match episode candidate and scene");
  assert.ok(candidate.rightsApproved === false &&
    candidate.editorialApproved === false &&
    candidate.thirdPartyRightsCleared === false &&
    candidate.downloadStatus === "NOT_DOWNLOADED",
  "Selection must be a yet-unapproved library candidate");
  assert.ok(Object.hasOwn(HOSTS, candidate.provider),
    "Provider lacks a compliant automatic media-download adapter");
  assert.ok(candidate.mediaType === "photo" || candidate.mediaType === "video");
  const direct = requireHttpsUrl(selection.directUrl, HOSTS[candidate.provider]);
  assert.equal(candidate.mediaType === "video", direct.ext === ".mp4",
    "Direct-file type does not match discovery media type");
  return {candidate, ...direct};
}

export function planQuarantineDownloads({library, selections, operatorConsent}) {
  assert.ok(library && library.schemaVersion === 1 &&
    library.publicationAllowed === false &&
    library.rightsStatus === "BLOCKED" &&
    Array.isArray(library.candidates) &&
    Array.isArray(library.searchPlan),
  "Only a blocked episode candidate library is accepted");
  assert.ok(operatorConsent && operatorConsent.approvePreviewAcquisition === true &&
    operatorConsent.allowRendering === false &&
    operatorConsent.allowPublication === false &&
    /^[a-zA-Z0-9._-]{3,90}$/.test(operatorConsent.operatorId),
  "Named, explicit download-only consent required");
  assert.ok(Array.isArray(selections) && selections.length >= 1 &&
    selections.length <= MAX_DOWNLOADS,
  "At most four manually selected files may be acquired per batch");
  const unique = new Set(), counts = new Map(), planned = [];
  for (const item of selections) {
    const {candidate, url, ext} = allowCandidate(library, item);
    assert.ok(!unique.has(candidate.motifId),
      "A source motif may only occur once within an acquisition batch");
    unique.add(candidate.motifId);
    counts.set(candidate.sceneId, (counts.get(candidate.sceneId) ?? 0) + 1);
    assert.ok(counts.get(candidate.sceneId) <= MAX_PER_SCENE,
      "Maximum two preview alternatives per scene and batch");
    planned.push({
      candidateId: candidate.id, sceneId: candidate.sceneId,
      provider: candidate.provider, motifId: candidate.motifId,
      sourcePage: candidate.sourcePage, creator: candidate.creator,
      licensePage: candidate.licensePage, mediaType: candidate.mediaType,
      url, ext,
    });
  }
  return Object.freeze({
    status: "OPERATOR_SELECTED_QUARANTINE_ONLY",
    episodeId: library.episodeId,
    operatorId: operatorConsent.operatorId,
    planned, maxFileBytes: MAX_FILE_BYTES,
    maxBatchBytes: MAX_BATCH_BYTES,
    rightsApproved: false, renderAllowed: false, publicationAllowed: false,
  });
}

/**
 * Downloads only user-reviewed direct-file URLs into a 0700 episode sandbox.
 * Streaming and file-size caps apply even if Content-Length lies.
 * Caller must persist the returned quarantine records in the private library;
 * this module never writes to public storage or the renderer input directory.
 */
export async function acquireQuarantinedMedia({
  plan, workspace, fetchImpl = fetch,
}) {
  await requirePrivateWorkspace(workspace);
  assert.ok(plan && plan.status === "OPERATOR_SELECTED_QUARANTINE_ONLY" &&
    plan.renderAllowed === false && plan.publicationAllowed === false &&
    Array.isArray(plan.planned) && plan.planned.length >= 1 &&
    plan.planned.length <= MAX_DOWNLOADS);
  const quarantine = join(workspace, "quarantine");
  await mkdir(quarantine, {recursive: false, mode: 0o700}).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  await requirePrivateWorkspace(quarantine);
  const completed = [];
  let accumulated = 0;
  for (const item of plan.planned) {
    // Validate again: do not accept a mutated/replayed plan with arbitrary URLs.
    const parsed = requireHttpsUrl(item.url, HOSTS[item.provider] ?? new Set());
    assert.equal(parsed.ext, item.ext);
    const response = await fetchImpl(item.url, {
      method: "GET", redirect: "error",
      headers: {Accept: FILE_TYPES[item.ext]},
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, "Download did not return 200 OK");
    const length = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_FILE_BYTES)
      throw new Error("Quarantine file size limit exceeded by Content-Length");
    const contentType = String(response.headers?.get?.("content-type") ?? "")
      .split(";")[0].trim().toLowerCase();
    assert.equal(contentType, FILE_TYPES[item.ext], "Unexpected media MIME type");
    assert.ok(response.body && typeof response.body[Symbol.asyncIterator] === "function",
      "Media source must support bounded streaming");
    const tmp = join(quarantine, ".incoming-" + randomBytes(12).toString("hex"));
    let file;
    let bytes = 0, start = Buffer.alloc(0);
    const hash = createHash("sha256");
    try {
      file = await open(tmp, "wx", 0o600);
      for await (const chunk of response.body) {
        assert.ok(chunk instanceof Uint8Array, "Invalid response chunk");
        bytes += chunk.byteLength;
        assert.ok(bytes <= MAX_FILE_BYTES && accumulated + bytes <= MAX_BATCH_BYTES,
          "Quarantine byte budget exceeded");
        if (start.length < 32)
          start = Buffer.concat([start, Buffer.from(chunk.subarray(0, 32 - start.length))]);
        hash.update(chunk);
        await file.writeFile(chunk);
      }
      assert.ok(bytes > 32);
      verifyMagic(start, item.ext);
      await file.close();
      file = null;
      const sha256 = hash.digest("hex");
      const stored = join(quarantine, sha256 + item.ext);
      await copyFile(tmp, stored, fsConstants.COPYFILE_EXCL);
      const copied = await readFile(stored);
      assert.equal(createHash("sha256").update(copied).digest("hex"), sha256);
      completed.push(Object.freeze({
        candidateId: item.candidateId, sceneId: item.sceneId,
        motifId: item.motifId, provider: item.provider,
        sourcePage: item.sourcePage, licensePage: item.licensePage,
        creator: item.creator, mediaType: item.mediaType,
        sha256, bytes, localPath: stored,
        status: "QUARANTINED_REVIEW_REQUIRED",
        rightsApproved: false, editorialApproved: false,
        thirdPartyRightsCleared: false,
      }));
      accumulated += bytes;
    } finally {
      if (file) await file.close().catch(() => {});
      await rm(tmp, {force: true});
    }
  }
  return {
    status: "QUARANTINE_ONLY_NOT_RENDERABLE",
    files: completed, bytes: accumulated,
    rightsApproved: false, renderAllowed: false,
    publicationAllowed: false,
  };
}

/**
 * Human-reviewed selections become a private cinematic manifest only after
 * source content was separately inspected and dated. This still grants no
 * episode publishing rights. The main P3 renderer validates duration and
 * chronology against the actual speech timeline separately.
 */
export async function buildReviewedPrivateClipManifest({
  library, quarantined, reviews, assetRoot,
}) {
  assert.ok(library && library.schemaVersion === 1 &&
    library.publicationAllowed === false &&
    library.rightsStatus === "BLOCKED" &&
    Array.isArray(library.candidates));
  assert.ok(Array.isArray(quarantined) && Array.isArray(reviews) &&
    reviews.length > 0 && reviews.length <= 4);
  await requirePrivateWorkspace(assetRoot);
  const byId = new Map(library.candidates.map(item => [item.id, item]));
  const records = new Map(quarantined.map(item => [item.candidateId, item]));
  const assets = [];
  const used = new Set();
  for (const review of reviews) {
    assert.ok(review && typeof review.candidateId === "string" &&
      !used.has(review.candidateId), "Duplicate review candidate");
    used.add(review.candidateId);
    const candidate = byId.get(review.candidateId);
    const file = records.get(review.candidateId);
    assert.ok(candidate && file && candidate.mediaType === "video" &&
      file.mediaType === "video" &&
      file.status === "QUARANTINED_REVIEW_REQUIRED" &&
      file.sceneId === candidate.sceneId &&
      file.motifId === candidate.motifId &&
      file.sourcePage === candidate.sourcePage,
    "Candidate must be a matching quarantined video source");
    assert.ok(review.rightsApproved === true &&
      review.editorialApproved === true &&
      review.thirdPartyRightsCleared === true &&
      review.reviewedFileSha256 === file.sha256 &&
      SHA.test(review.reviewedFileSha256),
    "Reviewer must approve and bind the exact local file bytes");
    assert.ok(typeof review.rightsReviewedBy === "string" &&
      /^[a-zA-Z0-9._-]{3,90}$/.test(review.rightsReviewedBy) &&
      typeof review.licenseEvidence === "string" &&
      review.licenseEvidence.trim().length >= 20 &&
      review.licenseEvidence.length <= 1000 &&
      /^\d{4}-\d{2}-\d{2}$/.test(review.captureDate) &&
      /^\d{4}-\d{2}-\d{2}$/.test(review.rightsReviewedAt),
    "Named reviewer, license evidence and real dates required");
    assert.ok(isAbsolute(file.localPath) &&
      dirname(file.localPath) === assetRoot &&
      basename(file.localPath) === file.sha256 + ".mp4",
    "Only hash-pinned local quarantined files may be rendered");
    assert.ok(/^beat-(0[1-9]|1[0-9])$/.test(review.endSceneId),
      "Review must specify valid endSceneId");
    assert.ok(review.insertFrames === undefined ||
      (Number.isSafeInteger(review.insertFrames) &&
        review.insertFrames >= 48 && review.insertFrames <= 24 * 90),
    "Optional short clip duration must be an integer frame count");
    const asset = {
      id: candidate.id,
      sceneId: candidate.sceneId,
      endSceneId: review.endSceneId,
      kind: "video", motifId: candidate.motifId,
      path: file.localPath, sha256: file.sha256,
      sourceUrl: candidate.sourcePage,
      creator: candidate.creator,
      credit: candidate.credit,
      licenseUrl: candidate.licensePage,
      licenseEvidence: review.licenseEvidence,
      rightsReviewedBy: review.rightsReviewedBy,
      rightsReviewedAt: review.rightsReviewedAt,
      captureDate: review.captureDate,
      rightsApproved: true, editorialApproved: true,
      thirdPartyRightsCleared: true,
      ...(review.insertFrames === undefined ? {} : {insertFrames: review.insertFrames}),
    };
    assets.push(asset);
  }
  const manifest = {schemaVersion: 1, assetRoot, assets};
  await validateEpisodeMediaManifest(manifest, assetRoot);
  return {
    status: "PRIVATE_CINEMATIC_MANIFEST_READY_FOR_SEPARATE_TIMELINE_CHECK",
    manifest,
    rightsStatus: "MEDIA_ONLY_REVIEWED_EPISODE_PUBLICATION_BLOCKED",
    uploadAllowed: false, publicationAllowed: false,
  };
}
