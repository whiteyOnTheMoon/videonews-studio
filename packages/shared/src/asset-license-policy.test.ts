import assert from "node:assert/strict";
import test from "node:test";
import { precheckAssetLicense } from "./asset-license-policy.js";

const BASE = {
  originUrl: "https://images.example.invalid/photos/42",
  creator: "Synthetic Creator",
  licenseCode: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  contentSha256: "a".repeat(64),
  attribution:
    "Synthetic Creator — https://images.example.invalid/photos/42 — CC BY 4.0 " +
    "https://creativecommons.org/licenses/by/4.0/",
  licenseSnapshot: {
    license_code: "CC-BY-4.0",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
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
  rightsStatus: "unreviewed",
};

function withLicense(code: string, url: string) {
  return {
    ...BASE,
    licenseCode: code,
    licenseUrl: url,
    licenseSnapshot: { ...BASE.licenseSnapshot, license_code: code, license_url: url },
    attribution: "Synthetic Creator — " + BASE.originUrl + " — " + code + " " + url,
  };
}

test("CC BY 4.0 with complete synthetic evidence passes only an offline precheck", () => {
  const decision = precheckAssetLicense(BASE);
  assert.deepEqual(decision, {
    status: "READY_FOR_NAMED_REVIEW",
    reasons: [],
    renderAllowed: false,
    uploadAllowed: false,
  });
});

test("CC0 1.0 is eligible for named review; no automatic render or upload", () => {
  const cc0 = withLicense("CC0-1.0", "https://creativecommons.org/publicdomain/zero/1.0/");
  const result = precheckAssetLicense(cc0);
  assert.equal(result.status, "READY_FOR_NAMED_REVIEW");
  assert.equal(result.renderAllowed, false);
  assert.equal(result.uploadAllowed, false);
});

test("CC BY credit and modification notices are mandatory for precheck", () => {
  const missing = precheckAssetLicense({ ...BASE, attribution: "Creator only" });
  assert.equal(missing.status, "BLOCKED");
  assert.ok(missing.reasons.includes("missing_attribution"));

  const changed = precheckAssetLicense({ ...BASE, modified: true });
  assert.equal(changed.status, "BLOCKED");
  assert.ok(changed.reasons.includes("missing_modification_notice"));

  const modified = precheckAssetLicense({
    ...BASE,
    modified: true,
    changeNotice: "Cropped for news video",
    attribution: BASE.attribution + " — Cropped for news video",
  });
  assert.equal(modified.status, "READY_FOR_NAMED_REVIEW");
  assert.equal(modified.renderAllowed, false);
});

test("ShareAlike requires individual editorial review, never silent clearance", () => {
  const record = withLicense("CC-BY-SA-4.0", "https://creativecommons.org/licenses/by-sa/4.0/");
  const decision = precheckAssetLicense(record);
  assert.equal(decision.status, "REVIEW_REQUIRED");
  assert.ok(decision.reasons.includes("sharealike_individual_review"));
  assert.equal(decision.renderAllowed, false);
});

test("NC and ND licenses are blocked under the project's commercial-video policy", () => {
  for (const [code, url, reason] of [
    ["CC-BY-NC-4.0", "https://creativecommons.org/licenses/by-nc/4.0/", "noncommercial_license"],
    ["CC-BY-ND-4.0", "https://creativecommons.org/licenses/by-nd/4.0/", "no_derivatives_license"],
    [
      "CC-BY-NC-SA-4.0",
      "https://creativecommons.org/licenses/by-nc-sa/4.0/",
      "noncommercial_license",
    ],
    [
      "CC-BY-NC-ND-4.0",
      "https://creativecommons.org/licenses/by-nc-nd/4.0/",
      "no_derivatives_license",
    ],
  ] as const) {
    const decision = precheckAssetLicense(withLicense(code, url));
    assert.equal(decision.status, "BLOCKED", code);
    assert.ok(decision.reasons.includes(reason), code);
    assert.equal(decision.renderAllowed, false);
  }
});

test("unknown license, alternate version, mismatch, or forged license host block", () => {
  for (const input of [
    { ...BASE, licenseCode: "UNKNOWN" },
    { ...BASE, licenseCode: "CC-BY-3.0" },
    { ...BASE, licenseUrl: "https://creativecommons.org.evil.invalid/licenses/by/4.0/" },
    { ...BASE, licenseSnapshot: { ...BASE.licenseSnapshot, license_code: "CC0-1.0" } },
    {
      ...BASE,
      licenseSnapshot: { ...BASE.licenseSnapshot, license_url: "https://example.invalid" },
    },
  ]) {
    assert.equal(precheckAssetLicense(input).status, "BLOCKED");
  }
});

test("absent, malformed, or spoofed provenance fails closed", () => {
  for (const input of [
    null,
    [],
    "not-an-asset",
    { ...BASE, originUrl: null },
    { ...BASE, originUrl: "http://images.example.invalid/42" },
    { ...BASE, originUrl: "https://images.example.invalid@evil.invalid/photo" },
    { ...BASE, creator: "" },
    { ...BASE, contentSha256: "not-a-hash" },
    { ...BASE, licenseSnapshot: {} },
    { ...BASE, licenseSnapshot: null },
    { ...BASE, licenseSnapshot: { ...BASE.licenseSnapshot, terms_sha256: "wrong" } },
    { ...BASE, licenseSnapshot: { ...BASE.licenseSnapshot, captured_at: "unknown" } },
    { ...BASE, attribution: null },
    { ...BASE, modified: "maybe" },
  ]) {
    const result = precheckAssetLicense(input);
    assert.equal(result.status, "BLOCKED", JSON.stringify(input));
    assert.equal(result.renderAllowed, false);
    assert.equal(result.uploadAllowed, false);
  }
});

test("people, trademarks, property and unknown third-party rights require review", () => {
  for (const key of ["identifiablePeople", "visibleTrademarks", "thirdPartyProperty"] as const) {
    const status = precheckAssetLicense({
      ...BASE,
      rightsFlags: { ...BASE.rightsFlags, [key]: true },
    });
    assert.equal(status.status, "REVIEW_REQUIRED", key);
    assert.equal(status.renderAllowed, false);
  }

  for (const rightsFlags of [
    { ...BASE.rightsFlags, identifiablePeople: "unknown" },
    { ...BASE.rightsFlags, visibleTrademarks: "unknown" },
    { ...BASE.rightsFlags, thirdPartyProperty: "unknown" },
    { ...BASE.rightsFlags, editorialOnly: "unknown" },
    { ...BASE.rightsFlags, identifiablePeople: null },
    { visibleTrademarks: false },
    {},
    null,
  ]) {
    const status = precheckAssetLicense({ ...BASE, rightsFlags });
    assert.equal(status.status, "REVIEW_REQUIRED");
    assert.ok(status.reasons.includes("third_party_rights_unknown"));
  }
});

test("explicit block and editorial-only restrictions override otherwise eligible licenses", () => {
  const manuallyBlocked = precheckAssetLicense({ ...BASE, rightsStatus: "blocked" });
  assert.deepEqual(manuallyBlocked, {
    status: "BLOCKED",
    reasons: ["explicitly_blocked"],
    renderAllowed: false,
    uploadAllowed: false,
  });
  const editorialOnly = precheckAssetLicense({
    ...BASE,
    rightsFlags: { ...BASE.rightsFlags, editorialOnly: true },
  });
  assert.equal(editorialOnly.status, "BLOCKED");
  assert.ok(editorialOnly.reasons.includes("editorial_use_only"));

  const compounded = precheckAssetLicense({
    ...BASE,
    licenseCode: "CC-BY-NC-4.0",
    rightsFlags: { ...BASE.rightsFlags, identifiablePeople: true },
  });
  assert.equal(compounded.status, "BLOCKED");
  assert.ok(compounded.reasons.includes("people_review_required"));
});
