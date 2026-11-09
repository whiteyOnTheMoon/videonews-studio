import assert from "node:assert/strict";
import test from "node:test";
import { buildOfflineVideoCreditsReport } from "./offline-video-credits-report.js";

const VIDEO_ID = "00000000-0000-4000-8000-000000000101";
const OTHER_VIDEO_ID = "00000000-0000-4000-8000-000000000102";
const ASSET_A = "00000000-0000-4000-8000-000000000201";
const ASSET_B = "00000000-0000-4000-8000-000000000202";
const URL = "https://creativecommons.org/licenses/by/4.0/";

const candidate = (assetId = ASSET_A) => ({
  assetId,
  usedInVideoId: VIDEO_ID,
  rightsStatus: "cleared",
  originUrl: "https://media.example.invalid/photo/5",
  creator: "Synthetic Photographer",
  licenseCode: "CC-BY-4.0",
  licenseUrl: URL,
  contentSha256: "a".repeat(64),
  attribution:
    "Synthetic Photographer — https://media.example.invalid/photo/5 — CC BY 4.0 " + URL,
  licenseSnapshot: {
    license_code: "CC-BY-4.0",
    license_url: URL,
    captured_at: "2026-11-08T00:00:00Z",
    terms_sha256: "b".repeat(64),
  },
  rightsFlags: {
    identifiablePeople: false,
    visibleTrademarks: false,
    thirdPartyProperty: false,
    editorialOnly: false,
  },
  modified: false,
  downloadReceipt: {
    downloaded_at: "2026-11-08T10:00:00Z",
    media_sha256: "a".repeat(64),
    terms_sha256: "b".repeat(64),
    origin_url: "https://media.example.invalid/photo/5",
  },
});

test("complete synthetic metadata yields proposed credits but not rights or publication", () => {
  const input = { videoId: VIDEO_ID, assets: [candidate()] };
  const result = buildOfflineVideoCreditsReport(input);
  assert.equal(result.schema, "p3-08-offline-credits-preview-v1");
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.renderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  assert.equal(result.creditsVerified, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]!.assetId, ASSET_A);
  assert.equal(result.entries[0]!.downloadEvidence, "RECORDED_UNVERIFIED");
  assert.equal(result.entries[0]!.licensePrecheck.status, "READY_FOR_NAMED_REVIEW");
  assert.equal(result.entries[0]!.mediaSha256, "a".repeat(64));
  assert.equal(result.entries[0]!.termsSha256, "b".repeat(64));
  assert.ok(result.entries[0]!.proposedCredit?.includes(URL));
  assert.deepEqual(result.reasons, ["named_rights_review_pending"]);
  assert.deepEqual(input, { videoId: VIDEO_ID, assets: [candidate()] });
});

test("a single missing download receipt blocks the entire mixed-assets report", () => {
  const result = buildOfflineVideoCreditsReport({
    videoId: VIDEO_ID,
    assets: [candidate(), { ...candidate(ASSET_B), downloadReceipt: null }],
  });
  assert.equal(result.entries.length, 2);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.renderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  assert.equal(result.entries[1]!.downloadEvidence, "MISSING_OR_MISMATCHED");
  assert.ok(result.reasons.includes("missing_or_mismatched_download_receipt"));
  assert.equal(result.entries[0]!.downloadEvidence, "RECORDED_UNVERIFIED");
});

test("receipt hash, origin, terms digest, timestamp mismatch always reported", () => {
  for (const change of [
    { media_sha256: "c".repeat(64) },
    { terms_sha256: "c".repeat(64) },
    { origin_url: "https://media.example.invalid/other" },
    { downloaded_at: "unknown" },
    { downloaded_at: "2026-13-99T10:00:00Z" },
  ]) {
    const result = buildOfflineVideoCreditsReport({
      videoId: VIDEO_ID,
      assets: [{ ...candidate(), downloadReceipt: { ...candidate().downloadReceipt, ...change } }],
    });
    assert.equal(result.entries[0]!.downloadEvidence, "MISSING_OR_MISMATCHED");
    assert.ok(result.reasons.includes("missing_or_mismatched_download_receipt"));
    assert.equal(result.renderAllowed, false);
  }
});

test("NC, explicit blocks and rights review cannot be overridden by valid receipts", () => {
  const base = candidate();
  const nc = {
    ...base,
    licenseCode: "CC-BY-NC-4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-nc/4.0/",
    licenseSnapshot: {
      ...base.licenseSnapshot,
      license_code: "CC-BY-NC-4.0",
      license_url: "https://creativecommons.org/licenses/by-nc/4.0/",
    },
  };
  const people = {
    ...candidate(ASSET_B),
    rightsFlags: { ...base.rightsFlags, identifiablePeople: true },
  };
  const result = buildOfflineVideoCreditsReport({
    videoId: VIDEO_ID,
    assets: [nc, people],
  });
  assert.equal(result.entries[0]!.licensePrecheck.status, "BLOCKED");
  assert.equal(result.entries[0]!.proposedCredit, null);
  assert.equal(result.entries[1]!.licensePrecheck.status, "REVIEW_REQUIRED");
  assert.ok(result.entries[1]!.proposedCredit);
  assert.ok(result.reasons.includes("license_precheck_blocked"));
  assert.ok(result.reasons.includes("license_review_pending"));
  assert.equal(result.renderAllowed, false);
  assert.equal(result.uploadAllowed, false);

  const explicit = buildOfflineVideoCreditsReport({
    videoId: VIDEO_ID,
    assets: [{ ...candidate(), rightsStatus: "blocked" }],
  });
  assert.equal(explicit.entries[0]!.licensePrecheck.status, "BLOCKED");
});

test("missing asset use, cross-video linkage, or duplicate identity are visible", () => {
  const cross = buildOfflineVideoCreditsReport({
    videoId: VIDEO_ID,
    assets: [{ ...candidate(), usedInVideoId: OTHER_VIDEO_ID }],
  });
  assert.ok(cross.reasons.includes("cross_video_asset_use"));

  const duplicate = buildOfflineVideoCreditsReport({
    videoId: VIDEO_ID,
    assets: [candidate(), candidate()],
  });
  assert.equal(duplicate.entries.length, 2);
  assert.ok(duplicate.reasons.includes("duplicate_asset_id"));
  assert.equal(duplicate.renderAllowed, false);
});

test("malformed requests, missing assets and excessive work fail closed", () => {
  for (const [payload, reason] of [
    [null, "invalid_video_id"],
    [{ videoId: VIDEO_ID, assets: null }, "invalid_asset_list"],
    [{ videoId: VIDEO_ID, assets: [] }, "no_assets"],
    [{ videoId: VIDEO_ID, assets: [null] }, "invalid_asset_record"],
    [{ videoId: "invalid", assets: [candidate()] }, "invalid_video_id"],
    [{ videoId: VIDEO_ID, assets: Array.from({ length: 26 }, () => candidate()) }, "too_many_assets"],
  ] as const) {
    const result = buildOfflineVideoCreditsReport(payload);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.renderAllowed, false);
    assert.equal(result.uploadAllowed, false);
    assert.equal(result.creditsVerified, false);
    assert.ok(result.reasons.includes(reason), reason);
  }
});

test("untrusted stored attribution is text-only, never executable markup", () => {
  const result = buildOfflineVideoCreditsReport({
    videoId: VIDEO_ID,
    assets: [{ ...candidate(), attribution: "<img src=x onerror=alert(1)>" }],
  });
  assert.equal(result.entries[0]!.proposedCredit, null);
  assert.equal(result.entries[0]!.licensePrecheck.status, "BLOCKED");
  assert.equal(result.renderAllowed, false);
});

test("forged approval and claimed publisher status cannot grant a release", () => {
  const result = buildOfflineVideoCreditsReport({
    videoId: VIDEO_ID,
    assets: [{ ...candidate(), namedReviewer: "fake-admin", publishApproved: true }],
    publishApproved: true,
    renderAllowed: true,
    uploadAllowed: true,
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.renderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  assert.equal(result.creditsVerified, false);
  assert.ok(result.reasons.includes("named_rights_review_pending"));
});
