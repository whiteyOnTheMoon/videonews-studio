/**
 * P3-03: Pexels API-shaped metadata boundary, OFFLINE ONLY.
 *
 * This module does not call Pexels, fetch media, use an API key, or persist.
 * Public API metadata does not demonstrate actual rights, release documents,
 * or a media-content hash. Every candidate is therefore BLOCKED.
 */

export type PexelsMediaType = "photo" | "video";

export type PexelsDiscoveryFailure =
  | "invalid_page"
  | "invalid_media_type"
  | "invalid_item"
  | "invalid_origin"
  | "invalid_creator"
  | "invalid_media_reference"
  | "duplicate_provider_id";

export interface PexelsDiscoveryCandidate {
  provider: "pexels";
  providerId: string;
  kind: "image" | "video";
  originUrl: string;
  creator: string;
  creatorProfileUrl: string;
  licenseCode: "PEXELS-CUSTOM";
  licenseUrl: "https://www.pexels.com/license/";
  attribution: string;
  providerAttribution: "Media provided by Pexels — https://www.pexels.com/";
  rightsStatus: "blocked";
  rightsFlags: {
    identifiablePeople: "unknown";
    visibleTrademarks: "unknown";
    thirdPartyProperty: "unknown";
    editorialOnly: "unknown";
  };
  contentSha256: null;
  licenseSnapshot: null;
  mediaDownloaded: false;
  renderAllowed: false;
  uploadAllowed: false;
  /** Suggested metadata cache lifetime, NOT an active cache. */
  cacheTtlSeconds: 86400;
}

export type PexelsDiscoveryResult =
  | {
      status: "BLOCKED_CANDIDATES";
      candidates: readonly PexelsDiscoveryCandidate[];
      reasons: readonly ["provider_license_and_releases_unverified"];
      renderAllowed: false;
      uploadAllowed: false;
    }
  | {
      status: "REJECTED";
      candidates: readonly [];
      reasons: readonly PexelsDiscoveryFailure[];
      renderAllowed: false;
      uploadAllowed: false;
    };

type AnyRecord = Record<string, unknown>;
const LICENSE = "https://www.pexels.com/license/";
const ATTRIBUTION = "Media provided by Pexels — https://www.pexels.com/";
const MAX_PER_PAGE = 80;

function object(value: unknown): AnyRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function safeName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 200 ||
    value.trim() !== value ||
    value.includes("<") ||
    value.includes(">")
  ) {
    return false;
  }
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function canonicalPexelsUrl(value: unknown, host: string, allowQuery = false): URL | null {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 2048 ||
    !value.startsWith("https://") ||
    value.trim() !== value ||
    /[\s\\]/.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== "" ||
      (!allowQuery && url.search !== "") ||
      (allowQuery && url.search.length > 256) ||
      url.pathname.includes("%") ||
      url.pathname.includes("//")
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function validOrigin(value: unknown, kind: PexelsMediaType, id: number): boolean {
  const url = canonicalPexelsUrl(value, "www.pexels.com");
  if (!url) return false;
  if (kind === "video") return url.pathname === "/video/" + id + "/";
  const path = url.pathname;
  const suffix = "-" + id + "/";
  return (
    path.startsWith("/photo/") &&
    path.endsWith(suffix) &&
    /^[a-z0-9-]+$/.test(path.slice("/photo/".length, -suffix.length))
  );
}

function validProfile(value: unknown): value is string {
  const url = canonicalPexelsUrl(value, "www.pexels.com");
  return url !== null && /^\/@[a-z0-9-]+\/?$/.test(url.pathname);
}

function validImageReference(value: unknown, kind: PexelsMediaType, id: number): boolean {
  // Official Pexels CDN thumbnails may carry bounded resizing queries.
  const url = canonicalPexelsUrl(value, "images.pexels.com", true);
  return (
    url !== null &&
    url.pathname.startsWith((kind === "photo" ? "/photos/" : "/videos/") + id + "/")
  );
}

function reject(reasons: readonly PexelsDiscoveryFailure[]): PexelsDiscoveryResult {
  return {
    status: "REJECTED",
    candidates: [],
    reasons: Object.freeze([...new Set(reasons)]),
    renderAllowed: false,
    uploadAllowed: false,
  };
}

function parseItem(
  input: unknown,
  type: PexelsMediaType,
): PexelsDiscoveryCandidate | PexelsDiscoveryFailure {
  const item = object(input);
  if (!item || !positiveId(item.id)) return "invalid_item";
  const id = item.id;
  if (!validOrigin(item.url, type, id)) return "invalid_origin";

  const user = type === "photo" ? item : object(item.user);
  const name = type === "photo" ? item.photographer : user?.name;
  const profile = type === "photo" ? item.photographer_url : user?.url;
  if (!safeName(name) || !validProfile(profile)) return "invalid_creator";

  const reference = type === "photo" ? object(item.src)?.original : item.image;
  if (!validImageReference(reference, type, id)) return "invalid_media_reference";

  const creator = name;
  const originUrl = item.url as string;
  const kind = type === "photo" ? "image" : "video";
  return {
    provider: "pexels",
    providerId: String(id),
    kind,
    originUrl,
    creator,
    creatorProfileUrl: profile,
    licenseCode: "PEXELS-CUSTOM",
    licenseUrl: LICENSE,
    attribution:
      (type === "photo" ? "Photo" : "Video") +
      " by " +
      creator +
      " on Pexels — " +
      originUrl,
    providerAttribution: ATTRIBUTION,
    rightsStatus: "blocked",
    rightsFlags: {
      identifiablePeople: "unknown",
      visibleTrademarks: "unknown",
      thirdPartyProperty: "unknown",
      editorialOnly: "unknown",
    },
    contentSha256: null,
    licenseSnapshot: null,
    mediaDownloaded: false,
    renderAllowed: false,
    uploadAllowed: false,
    cacheTtlSeconds: 86400,
  };
}

/**
 * Atomically validates a bounded, supplied Pexels API-shaped response.
 * Empty pages and broken items produce no candidates; no media URL or
 * authorization header is exported, logged, cached or fetched.
 */
export function readOfflinePexelsPage(
  value: unknown,
  type: PexelsMediaType,
): PexelsDiscoveryResult {
  if (type !== "photo" && type !== "video") return reject(["invalid_media_type"]);
  const page = object(value);
  const list = page?.[type === "photo" ? "photos" : "videos"];
  if (
    !page ||
    !positiveId(page.page) ||
    !positiveId(page.per_page) ||
    page.per_page > MAX_PER_PAGE ||
    !Array.isArray(list) ||
    list.length < 1 ||
    list.length > page.per_page
  ) {
    return reject(["invalid_page"]);
  }

  const candidates: PexelsDiscoveryCandidate[] = [];
  const ids = new Set<string>();
  for (const value of list) {
    const parsed = parseItem(value, type);
    if (typeof parsed === "string") return reject([parsed]);
    if (ids.has(parsed.providerId)) return reject(["duplicate_provider_id"]);
    ids.add(parsed.providerId);
    candidates.push(parsed);
  }
  return {
    status: "BLOCKED_CANDIDATES",
    candidates: Object.freeze(candidates),
    reasons: ["provider_license_and_releases_unverified"],
    renderAllowed: false,
    uploadAllowed: false,
  };
}
