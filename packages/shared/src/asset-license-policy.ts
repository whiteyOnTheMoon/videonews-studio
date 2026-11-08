/**
 * P3-02: conservative, offline commercial-media license PRECHECK.
 *
 * Inputs are untrusted metadata, not evidence of actual licensing. Even a
 * successful precheck is NOT a rights approval or render/upload authorization.
 * Human provenance checks and a real entrypoint gate remain separate.
 */

export type AssetLicensePrecheckStatus =
  | "BLOCKED"
  | "REVIEW_REQUIRED"
  | "READY_FOR_NAMED_REVIEW";

export type AssetLicensePrecheckReason =
  | "invalid_input"
  | "explicitly_blocked"
  | "missing_or_invalid_provenance"
  | "unknown_license"
  | "noncommercial_license"
  | "no_derivatives_license"
  | "license_reference_mismatch"
  | "missing_attribution"
  | "missing_modification_notice"
  | "modification_status_unknown"
  | "editorial_use_only"
  | "sharealike_individual_review"
  | "people_review_required"
  | "trademark_review_required"
  | "property_review_required"
  | "third_party_rights_unknown";

export interface AssetLicensePrecheck {
  status: AssetLicensePrecheckStatus;
  reasons: readonly AssetLicensePrecheckReason[];
  /** Always false until a separately approved, audited render gate exists. */
  renderAllowed: false;
  /** Always false. An asset license precheck never authorizes publication. */
  uploadAllowed: false;
}

type RecordValue = Record<string, unknown>;
type RightsFlag = boolean | "unknown";

const LICENSE_URLS: Readonly<Record<string, string>> = Object.freeze({
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC-BY-SA-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
  "CC-BY-NC-4.0": "https://creativecommons.org/licenses/by-nc/4.0/",
  "CC-BY-ND-4.0": "https://creativecommons.org/licenses/by-nd/4.0/",
  "CC-BY-NC-SA-4.0": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
  "CC-BY-NC-ND-4.0": "https://creativecommons.org/licenses/by-nc-nd/4.0/",
});

const SHA256 = /^[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function cleanText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= maximum &&
    value === value.trim() &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  );
}

function httpsUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 2048 ||
    value !== value.trim() ||
    !value.startsWith("https://") ||
    /[\s\\]/.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hash === "" &&
      !url.hostname.endsWith(".") &&
      url.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

function validSnapshot(value: unknown): value is RecordValue {
  const snapshot = record(value);
  if (
    !snapshot ||
    !cleanText(snapshot.license_code, 60) ||
    !httpsUrl(snapshot.license_url) ||
    typeof snapshot.captured_at !== "string" ||
    !INSTANT.test(snapshot.captured_at) ||
    !Number.isFinite(Date.parse(snapshot.captured_at)) ||
    typeof snapshot.terms_sha256 !== "string" ||
    !SHA256.test(snapshot.terms_sha256)
  ) {
    return false;
  }
  return true;
}

function rightsFlag(value: unknown): value is RightsFlag {
  return value === true || value === false || value === "unknown";
}

function decision(
  status: AssetLicensePrecheckStatus,
  reasons: readonly AssetLicensePrecheckReason[],
): AssetLicensePrecheck {
  return { status, reasons: Object.freeze([...reasons]), renderAllowed: false, uploadAllowed: false };
}

/**
 * Conservative policy for the project's proposed commercial news videos.
 * No fetching, paid APIs, inferred permission, or persistence occurs here.
 *
 * Expected fields match the P3-01 columns plus a structured license snapshot
 * and four explicit, untrusted third-party-rights observations. An "unknown"
 * observation cannot be treated as false. Any positive precheck is only a
 * candidate for subsequent named human review.
 */
export function precheckAssetLicense(input: unknown): AssetLicensePrecheck {
  const asset = record(input);
  if (!asset) return decision("BLOCKED", ["invalid_input"]);
  if (asset.rightsStatus === "blocked") {
    return decision("BLOCKED", ["explicitly_blocked"]);
  }
  if (asset.rightsStatus !== "unreviewed" && asset.rightsStatus !== "cleared") {
    return decision("BLOCKED", ["invalid_input"]);
  }

  const blocked: AssetLicensePrecheckReason[] = [];
  const review: AssetLicensePrecheckReason[] = [];
  const snapshot = record(asset.licenseSnapshot);
  const flags = record(asset.rightsFlags);

  if (
    !httpsUrl(asset.originUrl) ||
    !cleanText(asset.creator, 200) ||
    !httpsUrl(asset.licenseUrl) ||
    !validSnapshot(snapshot) ||
    typeof asset.contentSha256 !== "string" ||
    !SHA256.test(asset.contentSha256)
  ) {
    blocked.push("missing_or_invalid_provenance");
  }

  const licenseCode = asset.licenseCode;
  const expectedUrl = typeof licenseCode === "string" ? LICENSE_URLS[licenseCode] : undefined;
  if (!expectedUrl) {
    blocked.push("unknown_license");
  } else {
    // A license URL alone cannot prove the asset is under that license.
    // Mismatched authoritative reference and recorded snapshot always block.
    if (
      asset.licenseUrl !== expectedUrl ||
      snapshot?.license_code !== licenseCode ||
      snapshot?.license_url !== expectedUrl
    ) {
      blocked.push("license_reference_mismatch");
    }
    if (typeof licenseCode === "string" && licenseCode.includes("-NC")) blocked.push("noncommercial_license");
    if (typeof licenseCode === "string" && licenseCode.includes("-ND")) blocked.push("no_derivatives_license");
    if (licenseCode === "CC-BY-SA-4.0") review.push("sharealike_individual_review");
  }

  if (!cleanText(asset.attribution, 1000)) {
    blocked.push("missing_attribution");
  } else if (licenseCode !== "CC0-1.0") {
    // The editorial template requires TASL: creator, source and license URL.
    if (
      !cleanText(asset.creator, 200) ||
      !httpsUrl(asset.originUrl) ||
      !httpsUrl(asset.licenseUrl) ||
      !asset.attribution.includes(asset.creator) ||
      !asset.attribution.includes(asset.originUrl) ||
      !asset.attribution.includes(asset.licenseUrl)
    ) {
      blocked.push("missing_attribution");
    }
  }

  if (typeof asset.modified !== "boolean") {
    blocked.push("modification_status_unknown");
  } else if (asset.modified) {
    if (
      !cleanText(asset.changeNotice, 300) ||
      (licenseCode !== "CC0-1.0" &&
        (typeof asset.attribution !== "string" ||
          !asset.attribution.includes(asset.changeNotice)))
    ) {
      blocked.push("missing_modification_notice");
    }
  }

  if (!flags) {
    review.push("third_party_rights_unknown");
  } else {
    for (const key of ["identifiablePeople", "visibleTrademarks", "thirdPartyProperty", "editorialOnly"]) {
      if (!rightsFlag(flags[key])) {
        review.push("third_party_rights_unknown");
        break;
      }
    }
    if (flags.editorialOnly === true) blocked.push("editorial_use_only");
    if (flags.identifiablePeople === true) review.push("people_review_required");
    if (flags.visibleTrademarks === true) review.push("trademark_review_required");
    if (flags.thirdPartyProperty === true) review.push("property_review_required");
    if (
      flags.identifiablePeople === "unknown" ||
      flags.visibleTrademarks === "unknown" ||
      flags.thirdPartyProperty === "unknown" ||
      flags.editorialOnly === "unknown"
    ) {
      review.push("third_party_rights_unknown");
    }
  }

  if (blocked.length) return decision("BLOCKED", [...new Set(blocked), ...new Set(review)]);
  if (review.length) return decision("REVIEW_REQUIRED", [...new Set(review)]);
  return decision("READY_FOR_NAMED_REVIEW", []);
}
