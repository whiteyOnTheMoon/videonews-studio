import { isPlausiblePublicSourceUrl } from "./source-policy.js";
import { approvedSourceForUrl, type RegisteredResearchSource } from "./source-registry.js";

/**
 * REVIEW-ONLY prototype. It is not imported by pollers, SQL writers, or
 * projectors and never grants an article URL permission to be persisted.
 * Source owners must separately document the semantics of every query key.
 */
export interface ArticleQueryReviewPolicy {
  readonly sourceId: string;
  readonly baseUrl: string;
  readonly functionalKeys: readonly string[];
  readonly trackingKeys: readonly string[];
}

export interface ArticleQueryIdentityPreview {
  /** Exact original URL for editorial navigation. Never silently rewrite it. */
  readonly navigationUrl: string;
  /** Hypothetical dedupe identity; must NOT be used for live SQL commits. */
  readonly identityUrl: string;
}

const SAFE_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const SAFE_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
const TRACKING_ONLY = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
]);

/**
 * Pure deterministic dry-run, restricted to already approved synthetic or
 * separately inspected source registries. No network, persistence or logging.
 *
 * Returns null on ANY policy ambiguity, including unknown/duplicate keys,
 * encodings, empty values, blocked child paths or uncanonical original URLs.
 */
export function previewReviewedArticleQueryIdentity(
  value: unknown,
  source: RegisteredResearchSource,
  registry: readonly RegisteredResearchSource[],
  policy: ArticleQueryReviewPolicy,
): ArticleQueryIdentityPreview | null {
  if (
    typeof value !== "string" ||
    !isPlausiblePublicSourceUrl(value) ||
    value.length > 512 ||
    !source ||
    source.status !== "approved" ||
    !policy ||
    policy.sourceId !== source.id ||
    policy.baseUrl !== source.baseUrl ||
    !Array.isArray(policy.functionalKeys) ||
    !Array.isArray(policy.trackingKeys) ||
    policy.functionalKeys.length > 6 ||
    policy.trackingKeys.length > 6 ||
    policy.functionalKeys.length + policy.trackingKeys.length < 1 ||
    policy.functionalKeys.length + policy.trackingKeys.length > 8
  ) {
    return null;
  }

  const keys = [...policy.functionalKeys, ...policy.trackingKeys];
  if (
    keys.some((key) => typeof key !== "string" || !SAFE_KEY.test(key)) ||
    new Set(keys).size !== keys.length ||
    policy.trackingKeys.some((key) => !TRACKING_ONLY.has(key))
  ) {
    return null;
  }

  // No percent decoding or URL rewrite may occur, even during an offline
  // experiment. Only literal ASCII key=value parameters are allowed here.
  if (
    value.includes("%") ||
    value.includes("#") ||
    value.includes("/./") ||
    value.includes("/../") ||
    (value.match(/\?/g) ?? []).length !== 1
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.toString() !== value ||
    !parsed.search ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !value.startsWith(source.baseUrl) ||
    approvedSourceForUrl(value, registry)?.id !== source.id
  ) {
    return null;
  }

  const rawQuery = value.slice(value.indexOf("?") + 1);
  const pairs = rawQuery.split("&");
  if (pairs.length < 1 || pairs.length > 8) return null;
  const encountered = new Set<string>();
  const functional: Array<readonly [string, string]> = [];
  for (const pair of pairs) {
    if (pair.split("=").length !== 2) return null;
    const [key, val] = pair.split("=");
    if (
      !key ||
      !val ||
      !SAFE_KEY.test(key) ||
      !SAFE_VALUE.test(val) ||
      encountered.has(key) ||
      !keys.includes(key)
    ) {
      return null;
    }
    encountered.add(key);
    if (policy.functionalKeys.includes(key)) functional.push([key, val]);
  }

  // Ordering is irrelevant to distinct, unique functional keys; their VALUES
  // remain part of the identity. Tracking keys can be omitted ONLY because the
  // caller explicitly supplied that hypothetical reviewed policy.
  functional.sort(([a], [b]) => a.localeCompare(b, "en"));
  const originalPath = value.slice(0, value.indexOf("?"));
  const identityUrl =
    originalPath +
    (functional.length > 0 ? "?" + functional.map(([key, val]) => key + "=" + val).join("&") : "");

  if (approvedSourceForUrl(identityUrl, registry)?.id !== source.id) return null;
  return { navigationUrl: value, identityUrl };
}
