import assert from "node:assert/strict";
import test from "node:test";
import { precheckAssetLicense } from "./asset-license-policy.js";
import { inspectOfflineCommonsImageInfo } from "./commons-offline-imageinfo.js";

const FILE_TITLE = "File:Synthetic landscape.jpg";
const DESCRIPTION = "https://commons.wikimedia.org/wiki/File:Synthetic_landscape.jpg";
const DOWNLOAD = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic_landscape.jpg";
const BY_URL = "https://creativecommons.org/licenses/by/4.0/";

const metadata = (shortName = "CC BY 4.0", licenseUrl = BY_URL) => ({
  Artist: { value: "Synthetic Photographer" },
  LicenseShortName: { value: shortName },
  LicenseUrl: { value: licenseUrl },
  AttributionRequired: { value: "true" },
  NonFree: { value: "false" },
});

const file = (id = 101, extmetadata: unknown = metadata()) => ({
  pageid: id,
  ns: 6,
  title: FILE_TITLE,
  imageinfo: [
    {
      timestamp: "2026-11-08T10:20:30Z",
      mediatype: "BITMAP",
      mime: "image/jpeg",
      descriptionurl: DESCRIPTION,
      url: DOWNLOAD,
      extmetadata,
    },
  ],
});

const response = (page: unknown = file()) => ({
  batchcomplete: "",
  query: { pages: { "101": page } },
});

test("CC BY 4.0 retains complete candidate attribution and is always BLOCKED", () => {
  const payload = response();
  const result = inspectOfflineCommonsImageInfo(payload);
  assert.equal(result.status, "BLOCKED_CANDIDATES");
  assert.equal(result.renderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  if (result.status !== "BLOCKED_CANDIDATES") return;
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.provider, "wikimedia-commons");
  assert.equal(candidate.fileTitle, FILE_TITLE);
  assert.equal(candidate.originUrl, DESCRIPTION);
  assert.equal(candidate.creator, "Synthetic Photographer");
  assert.equal(candidate.licenseCode, "CC-BY-4.0");
  assert.equal(candidate.licenseUrl, BY_URL);
  assert.equal(
    candidate.attribution,
    "Synthetic Photographer — " + DESCRIPTION + " — CC BY 4.0 " + BY_URL,
  );
  assert.equal(candidate.rightsStatus, "blocked");
  assert.equal(candidate.contentSha256, null);
  assert.equal(candidate.licenseSnapshot, null);
  assert.equal(candidate.mediaDownloaded, false);
  assert.equal(candidate.modificationStatus, "unknown");
  assert.equal(candidate.renderAllowed, false);
  assert.equal(candidate.uploadAllowed, false);
  assert.ok(candidate.reviewReasons.includes("api_metadata_is_unverified"));
  assert.ok(candidate.reviewReasons.includes("modification_status_unknown"));
  assert.ok(candidate.reviewReasons.includes("third_party_rights_unknown"));
  assert.equal(precheckAssetLicense(candidate).status, "BLOCKED");
  assert.ok(!JSON.stringify(result).includes("upload.wikimedia.org"));
  assert.deepEqual(payload, response());
});

test("CC0 remains provenance-only, CC BY-SA requires individual share-alike review", () => {
  const variants = [
    ["CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "CC0-1.0"],
    ["CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/", "CC-BY-SA-4.0"],
  ] as const;
  for (const [short, url, expectedCode] of variants) {
    const result = inspectOfflineCommonsImageInfo(response(file(101, metadata(short, url))));
    assert.equal(result.status, "BLOCKED_CANDIDATES", short);
    if (result.status !== "BLOCKED_CANDIDATES") continue;
    const entry = result.candidates[0]!;
    assert.equal(entry.licenseCode, expectedCode);
    assert.equal(entry.renderAllowed, false);
    assert.equal(entry.uploadAllowed, false);
    assert.equal(precheckAssetLicense(entry).status, "BLOCKED");
    if (expectedCode === "CC-BY-SA-4.0") {
      assert.ok(entry.reviewReasons.includes("sharealike_requires_review"));
    }
  }
});

test("HTML artist and custom attribution are not executed or silently dropped", () => {
  for (const extra of [
    { Artist: { value: '<a href="https://commons.wikimedia.org/wiki/User:Fake">Alice</a>' } },
    { Artist: { value: "<script>alert(1)</script>" } },
    { Artist: { value: "Alice &amp; Bob" } },
    { Artist: { value: "" } },
  ]) {
    const ext = { ...metadata(), ...extra };
    const result = inspectOfflineCommonsImageInfo(response(file(101, ext)));
    assert.equal(result.status, "BLOCKED_CANDIDATES");
    if (result.status !== "BLOCKED_CANDIDATES") continue;
    assert.equal(result.candidates[0]!.creator, null);
    assert.equal(result.candidates[0]!.attribution, null);
    assert.ok(result.candidates[0]!.reviewReasons.includes("creator_html_or_unknown"));
    assert.ok(!JSON.stringify(result).includes("<script"));
    assert.ok(!JSON.stringify(result).includes("<a href"));
  }

  const custom = {
    ...metadata(),
    Attribution: { value: "Copyright 2026 Publisher — credit this way" },
  };
  const result = inspectOfflineCommonsImageInfo(response(file(101, custom)));
  assert.equal(result.status, "BLOCKED_CANDIDATES");
  if (result.status !== "BLOCKED_CANDIDATES") return;
  assert.equal(result.candidates[0]!.attribution, null);
  assert.ok(result.candidates[0]!.reviewReasons.includes("custom_attribution_requires_review"));
});

test("personality or trademark restrictions are preserved as required review", () => {
  const ext = { ...metadata(), Restrictions: { value: ["trademark", "personality"] } };
  const result = inspectOfflineCommonsImageInfo(response(file(101, ext)));
  assert.equal(result.status, "BLOCKED_CANDIDATES");
  if (result.status !== "BLOCKED_CANDIDATES") return;
  assert.ok(result.candidates[0]!.reviewReasons.includes("restriction_templates_require_review"));
  assert.deepEqual(result.candidates[0]!.rightsFlags, {
    identifiablePeople: "unknown",
    visibleTrademarks: "unknown",
    thirdPartyProperty: "unknown",
    editorialOnly: "unknown",
  });
  assert.equal(result.candidates[0]!.renderAllowed, false);
});

test("NC, ND, unsupported, misleading, and mixed licenses are rejected atomically", () => {
  const invalid = [
    ["CC BY-NC 4.0", "https://creativecommons.org/licenses/by-nc/4.0/"],
    ["CC BY-ND 4.0", "https://creativecommons.org/licenses/by-nd/4.0/"],
    ["CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/"],
    ["CC BY 4.0 / CC BY-SA 4.0", BY_URL],
    ["Public domain", "https://creativecommons.org/publicdomain/mark/1.0/"],
    ["__proto__", BY_URL],
    ["CC BY 4.0", "https://creativecommons.org.evil.invalid/licenses/by/4.0/"],
    ["CC BY-SA 4.0", BY_URL],
  ];
  for (const [short, url] of invalid) {
    const result = inspectOfflineCommonsImageInfo(response(file(101, metadata(short, url))));
    assert.equal(result.status, "REJECTED", short);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.renderAllowed, false);
    assert.equal(result.uploadAllowed, false);
  }

  const nonfree = { ...metadata(), NonFree: { value: "true" } };
  const result = inspectOfflineCommonsImageInfo(response(file(101, nonfree)));
  assert.equal(result.status, "REJECTED");
  if (result.status === "REJECTED") {
    assert.ok(result.reasons.includes("nonfree_or_restricted_license"));
  }
});

test("mismatched Commons origins, mime types, URLs and timestamps are rejected", () => {
  const original = file();
  const image = original.imageinfo[0]!;
  for (const changed of [
    { descriptionurl: "https://commons.wikimedia.org.evil.invalid/wiki/File:Synthetic_landscape.jpg" },
    { descriptionurl: "http://commons.wikimedia.org/wiki/File:Synthetic_landscape.jpg" },
    { descriptionurl: DESCRIPTION + "?download=1" },
    { url: "https://upload.wikimedia.org.evil.invalid/wikipedia/commons/a/ab/file.jpg" },
    { url: "https://upload.wikimedia.org@evil.invalid/wikipedia/commons/a/ab/file.jpg" },
    { url: "https://upload.wikimedia.org/other/path/file.jpg" },
    { mime: "image/svg+xml" },
    { mime: "application/pdf" },
    { mediatype: "VIDEO" },
    { timestamp: "never" },
    { timestamp: "2026-13-99T00:00:00Z" },
    { extmetadata: null },
  ]) {
    const result = inspectOfflineCommonsImageInfo(
      response({ ...original, imageinfo: [{ ...image, ...changed }] }),
    );
    assert.equal(result.status, "REJECTED", JSON.stringify(changed));
    assert.equal(result.candidates.length, 0);
  }
});

test("invalid file pages and mixed page batches cannot partly pass", () => {
  for (const changed of [
    { ns: 0 },
    { pageid: 0 },
    { title: "File:Escape.svg" },
    { title: "File:../../escape.jpg" },
    { title: "File:Synthetic landscape.jpg?raw" },
    { imageinfo: [] },
    { imageinfo: [file().imageinfo[0], file().imageinfo[0]] },
  ]) {
    const result = inspectOfflineCommonsImageInfo(response({ ...file(), ...changed }));
    assert.equal(result.status, "REJECTED", JSON.stringify(changed));
    assert.equal(result.candidates.length, 0);
  }

  const duplicate = {
    query: { pages: { "101": file(), "102": file(102) } },
  };
  const result = inspectOfflineCommonsImageInfo(duplicate);
  assert.equal(result.status, "REJECTED");
  if (result.status === "REJECTED") {
    assert.ok(result.reasons.includes("duplicate_file_page"));
  }

  const invalidMixed = {
    query: { pages: { "101": file(), "102": { ...file(102), ns: 0 } } },
  };
  const rejected = inspectOfflineCommonsImageInfo(invalidMixed);
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.candidates.length, 0);
});

test("no pages, invalid response, and too many entries fail closed", () => {
  for (const input of [
    null,
    {},
    { query: {} },
    { query: { pages: {} } },
    { query: { pages: [] } },
    { query: { pages: { "-1": { missing: true } } } },
    { query: { pages: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [
      String(i + 1),
      file(i + 1),
    ])) } },
  ]) {
    const result = inspectOfflineCommonsImageInfo(input);
    assert.equal(result.status, "REJECTED", JSON.stringify(input));
    assert.equal(result.candidates.length, 0);
    assert.equal(result.renderAllowed, false);
    assert.equal(result.uploadAllowed, false);
  }
});

test("forged publisher and license approvals are never accepted", () => {
  const result = inspectOfflineCommonsImageInfo({
    ...response(),
    rightsStatus: "cleared",
    renderAllowed: true,
    uploadAllowed: true,
    publisherApproved: true,
  });
  assert.equal(result.status, "BLOCKED_CANDIDATES");
  if (result.status !== "BLOCKED_CANDIDATES") return;
  assert.equal(result.candidates[0]!.rightsStatus, "blocked");
  assert.equal(result.renderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  assert.equal(result.candidates[0]!.contentSha256, null);
});
