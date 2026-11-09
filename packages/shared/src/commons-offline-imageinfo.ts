/**
 * P3-05: bounded, offline Wikimedia Commons imageinfo/extmetadata inspection.
 *
 * Wikimedia metadata is untrusted and often HTML formatted. This parser
 * neither fetches files nor validates authorship, copyright or licensing.
 * Every accepted candidate remains BLOCKED for rendering and upload.
 */

export type CommonsLicenseCode = "CC0-1.0" | "CC-BY-4.0" | "CC-BY-SA-4.0";

export type CommonsInspectionFailure =
  | "invalid_api_response"
  | "too_many_pages"
  | "invalid_file_page"
  | "invalid_file_reference"
  | "invalid_license_metadata"
  | "unsupported_or_ambiguous_license"
  | "nonfree_or_restricted_license"
  | "duplicate_file_page";

export type CommonsManualReviewReason =
  | "api_metadata_is_unverified"
  | "creator_html_or_unknown"
  | "custom_attribution_requires_review"
  | "restriction_templates_require_review"
  | "sharealike_requires_review"
  | "modification_status_unknown"
  | "third_party_rights_unknown";

export interface CommonsFileCandidate {
  provider: "wikimedia-commons";
  pageId: number;
  fileTitle: string;
  originUrl: string;
  creator: string | null;
  licenseCode: CommonsLicenseCode;
  licenseUrl: string;
  attribution: string | null;
  imageTimestamp: string;
  mediaType: "image";
  rightsStatus: "blocked";
  rightsFlags: {
    identifiablePeople: "unknown";
    visibleTrademarks: "unknown";
    thirdPartyProperty: "unknown";
    editorialOnly: "unknown";
  };
  reviewReasons: readonly CommonsManualReviewReason[];
  licenseSnapshot: null;
  contentSha256: null;
  modificationStatus: "unknown";
  mediaDownloaded: false;
  renderAllowed: false;
  uploadAllowed: false;
}

export type CommonsInspectionResult =
  | {
      status: "BLOCKED_CANDIDATES";
      candidates: readonly CommonsFileCandidate[];
      renderAllowed: false;
      uploadAllowed: false;
    }
  | {
      status: "REJECTED";
      candidates: readonly [];
      reasons: readonly CommonsInspectionFailure[];
      renderAllowed: false;
      uploadAllowed: false;
    };

type RecordValue = Record<string, unknown>;

const LICENSES: Readonly<
  Record<string, { code: CommonsLicenseCode; url: string; shareAlike: boolean }>
> = Object.freeze({
  "CC0 1.0": {
    code: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
    shareAlike: false,
  },
  "CC BY 4.0": {
    code: "CC-BY-4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
    shareAlike: false,
  },
  "CC BY-SA 4.0": {
    code: "CC-BY-SA-4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
    shareAlike: true,
  },
});

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ALLOWED_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILES_PER_RESPONSE = 10;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safePlainText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= max &&
    value === value.trim() &&
    !/[<>&]/.test(value) &&
    ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    })
  );
}

function validTitle(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("File:") ||
    value.length < 11 ||
    value.length > 190 ||
    !/\.(?:jpg|jpeg|png|webp)$/i.test(value)
  ) {
    return false;
  }
  const name = value.slice("File:".length);
  return (
    name === name.trim() &&
    !/[<>|#?%[\]{}\/\\]/.test(name) &&
    ![...name].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code < 32 || code === 127);
    })
  );
}

function canonicalUrl(value: unknown, hostname: string): string | null {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 2048 ||
    !value.startsWith("https://") ||
    value !== value.trim() ||
    /[\s\\]/.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== hostname ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.pathname.includes("//")
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function metadataValue(extmetadata: RecordValue, key: string): unknown {
  return record(extmetadata[key])?.value;
}

function rejected(reason: CommonsInspectionFailure): CommonsInspectionResult {
  return {
    status: "REJECTED",
    candidates: [],
    reasons: [reason],
    renderAllowed: false,
    uploadAllowed: false,
  };
}

function parsePage(value: unknown, key: string): CommonsFileCandidate | CommonsInspectionFailure {
  const page = record(value);
  if (
    !page ||
    !validId(page.pageid) ||
    String(page.pageid) !== key ||
    page.ns !== 6 ||
    !validTitle(page.title) ||
    !Array.isArray(page.imageinfo) ||
    page.imageinfo.length !== 1
  ) {
    return "invalid_file_page";
  }

  const image = record(page.imageinfo[0]);
  const title = page.title;
  const expectedPageUrl =
    "https://commons.wikimedia.org/wiki/File:" +
    encodeURIComponent(title.slice("File:".length).replaceAll(" ", "_"));
  if (
    !image ||
    image.mediatype !== "BITMAP" ||
    !ALLOWED_MIMES.has(image.mime) ||
    image.descriptionurl !== expectedPageUrl ||
    canonicalUrl(image.descriptionurl, "commons.wikimedia.org") === null ||
    canonicalUrl(image.url, "upload.wikimedia.org") === null ||
    !image.url.startsWith("https://upload.wikimedia.org/wikipedia/commons/") ||
    typeof image.timestamp !== "string" ||
    !TIMESTAMP.test(image.timestamp) ||
    !Number.isFinite(Date.parse(image.timestamp))
  ) {
    return "invalid_file_reference";
  }

  const extmetadata = record(image.extmetadata);
  if (!extmetadata) return "invalid_license_metadata";
  if (
    metadataValue(extmetadata, "NonFree") === "true" ||
    metadataValue(extmetadata, "NonFree") === "True"
  ) {
    return "nonfree_or_restricted_license";
  }

  const shortName = metadataValue(extmetadata, "LicenseShortName");
  const licenseUrl = metadataValue(extmetadata, "LicenseUrl");
  if (typeof shortName !== "string" || typeof licenseUrl !== "string") {
    return "invalid_license_metadata";
  }
  const matched = LICENSES[shortName];
  if (!matched) return "unsupported_or_ambiguous_license";
  if (licenseUrl !== matched.url) return "invalid_license_metadata";

  // HTML-formatted authors must be resolved by a human; do not parse, strip
  // tags, guess at the uploader, or silently omit an attribution instruction.
  const rawCreator = metadataValue(extmetadata, "Artist");
  const creator = safePlainText(rawCreator, 200) ? rawCreator : null;
  const customAttribution = metadataValue(extmetadata, "Attribution");
  const hasCustomAttribution =
    typeof customAttribution === "string" && customAttribution.trim() !== "";
  const restrictions = metadataValue(extmetadata, "Restrictions");
  const hasRestrictions =
    Array.isArray(restrictions)
      ? restrictions.length > 0
      : typeof restrictions === "string"
        ? restrictions.trim() !== ""
        : restrictions !== undefined && restrictions !== null;

  const reviewReasons: CommonsManualReviewReason[] = [
    "api_metadata_is_unverified",
    "modification_status_unknown",
    "third_party_rights_unknown",
  ];
  if (!creator) reviewReasons.push("creator_html_or_unknown");
  if (hasCustomAttribution) reviewReasons.push("custom_attribution_requires_review");
  if (hasRestrictions) reviewReasons.push("restriction_templates_require_review");
  if (matched.shareAlike) reviewReasons.push("sharealike_requires_review");

  const attribution =
    creator && !hasCustomAttribution
      ? creator + " — " + expectedPageUrl + " — " + shortName + " " + matched.url
      : null;

  return {
    provider: "wikimedia-commons",
    pageId: page.pageid,
    fileTitle: title,
    originUrl: expectedPageUrl,
    creator,
    licenseCode: matched.code,
    licenseUrl: matched.url,
    attribution,
    imageTimestamp: image.timestamp,
    mediaType: "image",
    rightsStatus: "blocked",
    rightsFlags: {
      identifiablePeople: "unknown",
      visibleTrademarks: "unknown",
      thirdPartyProperty: "unknown",
      editorialOnly: "unknown",
    },
    reviewReasons: Object.freeze(reviewReasons),
    licenseSnapshot: null,
    contentSha256: null,
    modificationStatus: "unknown",
    mediaDownloaded: false,
    renderAllowed: false,
    uploadAllowed: false,
  };
}

/**
 * Pure parser for *supplied*, untrusted Commons API action=query
 * prop=imageinfo iiprop=timestamp|url|mime|mediatype|extmetadata output.
 * Never makes a network request, writes a file, or approves an asset.
 * On any bad page, the entire response is rejected without candidates.
 */
export function inspectOfflineCommonsImageInfo(input: unknown): CommonsInspectionResult {
  const root = record(input);
  const query = record(root?.query);
  const pages = record(query?.pages);
  if (!root || !query || !pages) return rejected("invalid_api_response");
  const entries = Object.entries(pages);
  if (entries.length < 1 || entries.length > MAX_FILES_PER_RESPONSE) {
    return rejected("too_many_pages");
  }

  const candidates: CommonsFileCandidate[] = [];
  const titles = new Set<string>();
  for (const [key, value] of entries) {
    const parsed = parsePage(value, key);
    if (typeof parsed === "string") return rejected(parsed);
    if (titles.has(parsed.fileTitle)) return rejected("duplicate_file_page");
    titles.add(parsed.fileTitle);
    candidates.push(parsed);
  }
  return {
    status: "BLOCKED_CANDIDATES",
    candidates: Object.freeze(candidates),
    renderAllowed: false,
    uploadAllowed: false,
  };
}
