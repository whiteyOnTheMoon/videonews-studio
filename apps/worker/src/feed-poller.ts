import { approvedSourceForUrl, type RegisteredResearchSource } from "./source-registry.js";
import { feedResponseMaxBytes } from "./feed-nasa-bounded-response.js";
import { isPlausiblePublicSourceUrl } from "./source-policy.js";

export interface FeedItem {
  sourceId: string;
  url: string;
  headline: string;
  publishedAt: string | null;
  reviewStatus: "candidate";
}

export interface FeedValidators {
  etag: string | null;
  lastModified: string | null;
}

export interface FeedPollLease {
  token: string;
  validators: FeedValidators;
}

export interface FeedSourceAuthority {
  /** Reject changed, blocked or host-revoked source snapshots before HTTP. */
  admitted(source: RegisteredResearchSource): Promise<boolean>;
}

export interface FeedPollStore {
  /**
   * Must atomically reserve (sourceId, next eligible time) across workers.
   * A failed request still consumes the interval: never hammer a source.
   */
  claim(sourceId: string, now: Date, intervalMinutes: number): Promise<FeedPollLease | null>;
  /** Must atomically deduplicate by (sourceId, canonical URL), then commit validators. */
  commit(
    sourceId: string,
    token: string,
    items: readonly FeedItem[],
    validators: FeedValidators,
  ): Promise<number>;
}

export interface FeedResponse {
  status: 200 | 304;
  mediaType: string | null;
  body: string;
  etag: string | null;
  lastModified: string | null;
}

export interface FeedTransport {
  /**
   * Injected only. No implementation in the running worker.
   * A real adapter MUST use the DNS-pinned, no-redirect and byte-limited
   * HTTPS boundary; never call unrestricted fetch with registry URLs.
   */
  request(source: RegisteredResearchSource, validators: FeedValidators): Promise<FeedResponse>;
}

export interface PollResult {
  sourceId: string;
  status: "not_modified" | "ingested" | "failed";
  newItems: number;
}

/** Closed, non-sensitive stage labels. Never expose raw URLs, XML or SQL. */
export type FeedPollFailureStage =
  | "source_grant"
  | "lease_claim"
  | "lease_validation"
  | "source_grant_before_https"
  | "https_transport"
  | "feed_decode"
  | "source_grant_before_commit"
  | "metadata_commit";

/** Source-code-controlled labels only: no upstream XML, URL, headline or exception. */
export type FeedDecodeRefusalKind =
  | "response_invalid"
  | "media_type_refused"
  | "xml_unsafe"
  | "xml_envelope_invalid"
  | "no_supported_items"
  | "no_approved_metadata"
  | "official_json_invalid"
  | "official_shape_invalid"
  | "other";

/** Never export raw Error.message: compare only exact static decoder failures. */
export function classifyFeedDecodeRefusal(reason: unknown): FeedDecodeRefusalKind {
  const message = reason instanceof Error ? reason.message : null;
  switch (message) {
    case "Feed response invalid":
      return "response_invalid";
    case "Feed media type refused":
      return "media_type_refused";
    case "Feed XML unsafe":
      return "xml_unsafe";
    case "Feed XML envelope invalid":
      return "xml_envelope_invalid";
    case "Feed has no supported items":
      return "no_supported_items";
    case "Feed has no approved metadata":
      return "no_approved_metadata";
    case "Official feed JSON invalid":
      return "official_json_invalid";
    case "Official feed shape invalid":
      return "official_shape_invalid";
    default:
      return "other";
  }
}

const MAX_ITEMS = 20;

function textField(xml: string, name: string): string | null {
  const match = new RegExp("<" + name + "(?:\\s[^<>]*)?>([\\s\\S]*?)</" + name + ">", "i").exec(
    xml,
  );
  if (!match) return null;
  let value = match[1]?.trim() ?? "";
  if (value.startsWith("<![CDATA[") && value.endsWith("]]>")) {
    value = value.slice(9, -3);
  } else {
    if (/<|>/.test(value)) return null;
    if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) return null;
    value = value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => {
      const mapping: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
      };
      return mapping[name] ?? "";
    });
  }
  return value.length > 0 && value.length <= 200 ? value : null;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function validTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 8 &&
    value.length <= 200 &&
    !/[<>]/.test(value) &&
    !hasControlCharacters(value)
  );
}

function canonicalArticle(
  value: unknown,
  source: RegisteredResearchSource,
  registry: readonly RegisteredResearchSource[],
): string | null {
  if (!isPlausiblePublicSourceUrl(value)) return null;
  const url = new URL(value);
  // The guarded PostgreSQL commit rejects query strings, percent encoding,
  // fragments and dot segments. A single URL that passes this decoder but
  // fails the SQL batch guard otherwise rejects every otherwise valid item.
  // Never strip tracking parameters or rewrite unapproved links: omit them.
  if (
    url.toString() !== value ||
    !value.startsWith(source.baseUrl) ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("/./") ||
    value.includes("/../")
  ) {
    return null;
  }
  const matched = approvedSourceForUrl(value, registry);
  return matched?.id === source.id ? value : null;
}

function publishedTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 60) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function parseXmlItems(body: string, source: RegisteredResearchSource): unknown[] {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<script/i.test(body)) {
    throw new Error("Feed XML unsafe");
  }
  const rss = source.access === "rss";
  if (
    (rss && !/^\s*(?:<\?xml[^>]*>\s*)?<rss(?:\s[^>]*)?>[\s\S]*<\/rss>\s*$/i.test(body)) ||
    (!rss && !/^\s*(?:<\?xml[^>]*>\s*)?<feed(?:\s[^>]*)?>[\s\S]*<\/feed>\s*$/i.test(body))
  ) {
    throw new Error("Feed XML envelope invalid");
  }
  const token = rss ? "item" : "entry";
  const pattern = new RegExp("<" + token + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + token + ">", "gi");
  const records: unknown[] = [];
  for (const match of body.matchAll(pattern)) {
    // Keep the per-request metadata cap even when an official RSS feed lists
    // more than 20 entries. The complete body is already byte-limited and
    // checked for forbidden XML constructs before iterating; never fetch
    // article bodies or silently raise the HTTPS response limit.
    if (records.length >= MAX_ITEMS) break;
    const fragment = match[1] ?? "";
    const headline = textField(fragment, "title");
    const anchor = rss
      ? textField(fragment, "link")
      : (/<link\s+[^>]*href="([^"]+)"[^>]*\/?>/i.exec(fragment)?.[1] ?? null);
    const publishedAt = rss
      ? textField(fragment, "pubDate")
      : (textField(fragment, "updated") ?? textField(fragment, "published"));
    records.push({ headline, url: anchor, publishedAt });
  }
  if (records.length === 0) throw new Error("Feed has no supported items");
  return records;
}

function parseJsonItems(body: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Official feed JSON invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("items" in parsed) ||
    !Array.isArray(parsed.items) ||
    parsed.items.length < 1 ||
    parsed.items.length > MAX_ITEMS
  ) {
    throw new Error("Official feed shape invalid");
  }
  return parsed.items as unknown[];
}

/** Metadata-only adapter: no description, story body, HTML or claim verification. */
export function decodeApprovedFeed(
  source: RegisteredResearchSource,
  registry: readonly RegisteredResearchSource[],
  response: FeedResponse,
  nasaReviewEnabled = false,
): readonly FeedItem[] {
  const maxBytes = feedResponseMaxBytes(source, nasaReviewEnabled);
  if (
    response.status !== 200 ||
    typeof response.body !== "string" ||
    response.body.length < 1 ||
    Buffer.byteLength(response.body, "utf8") > maxBytes
  ) {
    throw new Error("Feed response invalid");
  }
  const mediaType = response.mediaType?.split(";")[0]?.toLowerCase().trim();
  const permitted =
    source.access === "rss"
      ? ["application/rss+xml", "application/xml", "text/xml"]
      : source.access === "atom"
        ? ["application/atom+xml", "application/xml", "text/xml"]
        : source.access === "official_api"
          ? ["application/json"]
          : [];
  if (!mediaType || !permitted.includes(mediaType)) throw new Error("Feed media type refused");
  const raw =
    source.access === "official_api"
      ? parseJsonItems(response.body)
      : parseXmlItems(response.body, source);
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const url = canonicalArticle(entry.url, source, registry);
    if (!url || !validTitle(entry.headline) || seen.has(url)) continue;
    const publishedAt = publishedTime(entry.publishedAt);
    if (entry.publishedAt && !publishedAt) continue;
    seen.add(url);
    items.push({
      sourceId: source.id,
      url,
      headline: entry.headline,
      publishedAt,
      reviewStatus: "candidate",
    });
  }
  if (items.length === 0) throw new Error("Feed has no approved metadata");
  return items;
}

/**
 * Operator-only, in-memory explanation of an already rejected RSS response.
 * Uses the EXACT same parser, canonicalArticle, title and date admission
 * predicates as decodeApprovedFeed. No raw URL, headline, date, or XML escapes.
 * Never called by a running scheduler or regular feed commit.
 */
export interface FeedLinkRejectionReasons {
  readonly missingOrUnreadable: number;
  readonly queryString: number;
  readonly fragment: number;
  readonly percentEncoded: number;
  readonly dotSegments: number;
  readonly invalidPublicUrl: number;
  readonly nonCanonical: number;
  readonly blockedOrUnapprovedScope: number;
  readonly other: number;
}

export interface FeedMetadataRejectionCounts {
  readonly scanned: number;
  readonly outsideApprovedPrefix: number;
  readonly invalidOrBlockedLink: number;
  readonly linkFailureReasons: FeedLinkRejectionReasons;
  readonly invalidHeadline: number;
  readonly invalidPublishedAt: number;
  readonly duplicate: number;
  readonly accepted: number;
}

/**
 * Exclusive, fixed-code classification of a link that the UNCHANGED
 * canonicalArticle gate has already refused. No URL or content is returned.
 */
function refusedCanonicalLinkReason(
  value: unknown,
  source: RegisteredResearchSource,
  registry: readonly RegisteredResearchSource[],
): keyof FeedLinkRejectionReasons {
  if (typeof value !== "string" || value.length === 0) return "missingOrUnreadable";
  if (value.includes("?")) return "queryString";
  if (value.includes("#")) return "fragment";
  if (value.includes("%")) return "percentEncoded";
  if (value.includes("/./") || value.includes("/../")) return "dotSegments";
  if (!isPlausiblePublicSourceUrl(value)) return "invalidPublicUrl";
  try {
    if (new URL(value).toString() !== value) return "nonCanonical";
  } catch {
    return "invalidPublicUrl";
  }
  if (approvedSourceForUrl(value, registry)?.id !== source.id) {
    return "blockedOrUnapprovedScope";
  }
  return "other";
}

export function summarizeFeedMetadataRejections(
  source: RegisteredResearchSource,
  registry: readonly RegisteredResearchSource[],
  response: FeedResponse,
): FeedMetadataRejectionCounts {
  const raw =
    source.access === "official_api"
      ? parseJsonItems(response.body)
      : parseXmlItems(response.body, source);
  const result = {
    scanned: raw.length,
    outsideApprovedPrefix: 0,
    invalidOrBlockedLink: 0,
    linkFailureReasons: {
      missingOrUnreadable: 0,
      queryString: 0,
      fragment: 0,
      percentEncoded: 0,
      dotSegments: 0,
      invalidPublicUrl: 0,
      nonCanonical: 0,
      blockedOrUnapprovedScope: 0,
      other: 0,
    },
    invalidHeadline: 0,
    invalidPublishedAt: 0,
    duplicate: 0,
    accepted: 0,
  };
  const seen = new Set<string>();
  for (const value of raw) {
    const entry =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const url = canonicalArticle(entry.url, source, registry);
    if (!url) {
      if (typeof entry.url === "string" && !entry.url.startsWith(source.baseUrl)) {
        result.outsideApprovedPrefix++;
      } else {
        result.invalidOrBlockedLink++;
        const reason = refusedCanonicalLinkReason(entry.url, source, registry);
        result.linkFailureReasons[reason]++;
      }
      continue;
    }
    if (!validTitle(entry.headline)) {
      result.invalidHeadline++;
      continue;
    }
    if (seen.has(url)) {
      result.duplicate++;
      continue;
    }
    if (entry.publishedAt && !publishedTime(entry.publishedAt)) {
      result.invalidPublishedAt++;
      continue;
    }
    seen.add(url);
    result.accepted++;
  }
  return result;
}

/**
 * OPTIONAL, operator-only dry-run. Runs solely on an already rejected,
 * already downloaded RSS body. This is NOT an ingestion/canonicalization
 * policy and never mutates feed items, SQL, the source registry, or any URL.
 *
 * A fixed allowlist of familiar analytics parameter NAMES (not values) is
 * shown. Unknown keys, raw URLs, query values and headlines NEVER escape.
 */
const TRACKING_QUERY_KEYS = [
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
] as const;

export interface RejectedFeedTrackingQueryPreview {
  readonly inspectedQueryLinks: number;
  readonly trackingKeysOnly: number;
  readonly unknownOrMixedKeys: number;
  readonly malformedOrUnusableQuery: number;
  readonly recognizedKeyCounts: Record<(typeof TRACKING_QUERY_KEYS)[number], number>;
  readonly wouldPassExistingUrlAndMetadataGuards: number;
  readonly canonicalCollisions: number;
}

export function previewRejectedFeedTrackingQueries(
  source: RegisteredResearchSource,
  registry: readonly RegisteredResearchSource[],
  response: FeedResponse,
): RejectedFeedTrackingQueryPreview {
  if (source.access !== "rss" || response.status !== 200) {
    throw new Error("Feed preview scope refused");
  }
  const raw = parseXmlItems(response.body, source);
  const keyCounts: Record<(typeof TRACKING_QUERY_KEYS)[number], number> = Object.fromEntries(
    TRACKING_QUERY_KEYS.map((key) => [key, 0]),
  ) as Record<(typeof TRACKING_QUERY_KEYS)[number], number>;
  const approvedKeys: ReadonlySet<string> = new Set(TRACKING_QUERY_KEYS);
  const result = {
    inspectedQueryLinks: 0,
    trackingKeysOnly: 0,
    unknownOrMixedKeys: 0,
    malformedOrUnusableQuery: 0,
    recognizedKeyCounts: keyCounts,
    wouldPassExistingUrlAndMetadataGuards: 0,
    canonicalCollisions: 0,
  };
  const candidateCanonicalUrls = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const link = entry.url;
    if (typeof link !== "string" || !link.includes("?")) continue;
    result.inspectedQueryLinks++;
    if (!isPlausiblePublicSourceUrl(link) || link.includes("#") || link.length > 512) {
      result.malformedOrUnusableQuery++;
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      result.malformedOrUnusableQuery++;
      continue;
    }
    if (
      parsed.toString() !== link ||
      !parsed.search ||
      parsed.searchParams.size < 1 ||
      parsed.searchParams.size > 10
    ) {
      result.malformedOrUnusableQuery++;
      continue;
    }
    const unique = new Set<string>();
    let known = true;
    for (const [key, value] of parsed.searchParams) {
      if (!approvedKeys.has(key) || unique.has(key) || !value || value.length > 200) {
        known = false;
        continue;
      }
      unique.add(key);
    }
    if (!known || unique.size !== parsed.searchParams.size) {
      result.unknownOrMixedKeys++;
      continue;
    }
    result.trackingKeysOnly++;
    for (const key of unique) {
      result.recognizedKeyCounts[key as (typeof TRACKING_QUERY_KEYS)[number]]++;
    }

    // Bounded *simulation*: use existing URL, title and date gates, without
    // publishing or returning the candidate URL. Distinct query-bearing
    // entries may collapse to the same canonical path; count that explicitly.
    const dryRunPath = link.slice(0, link.indexOf("?"));
    const canonical = canonicalArticle(dryRunPath, source, registry);
    if (
      !canonical ||
      !validTitle(entry.headline) ||
      (entry.publishedAt && !publishedTime(entry.publishedAt))
    ) {
      continue;
    }
    if (candidateCanonicalUrls.has(canonical)) {
      result.canonicalCollisions++;
      continue;
    }
    candidateCanonicalUrls.add(canonical);
    result.wouldPassExistingUrlAndMetadataGuards++;
  }
  return result;
}

function safeValidator(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error("Feed cache validator invalid");
  }
  if (hasControlCharacters(value)) throw new Error("Feed cache validator invalid");
  return value;
}

/**
 * Single, explicit offline tick. No timer, no worker wiring and no network port.
 * Only approved RSS/Atom/official JSON sources are eligible. The storage port
 * owns distributed interval locks and durable idempotency.
 */
export function createDormantFeedPoller(
  registry: readonly RegisteredResearchSource[],
  enabled: boolean,
  store: FeedPollStore,
  transport: FeedTransport,
  authority?: FeedSourceAuthority,
  onFailure?: (sourceId: string, stage: FeedPollFailureStage) => void,
  oneShotSourceId?: string,
  nasaReviewEnabled = false,
  onDecodeRefusal?: (sourceId: string, kind: FeedDecodeRefusalKind) => void,
  onRejectedMetadata?: (sourceId: string, counts: FeedMetadataRejectionCounts) => void,
): { poll(now: Date): Promise<readonly PollResult[]> } {
  if (enabled !== true || !store || !transport) {
    throw new Error("Feed polling requires explicit offline authorization");
  }
  const sources = registry.filter(
    (source) =>
      source.status === "approved" &&
      ["rss", "atom", "official_api"].includes(source.access) &&
      approvedSourceForUrl(source.baseUrl, registry)?.id === source.id,
  );
  if (sources.length < 3 || sources.length > 5) {
    throw new Error("Feed polling requires three to five reviewed sources");
  }
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    throw new Error("Duplicate feed source identity");
  }
  if (oneShotSourceId !== undefined && !sources.some((source) => source.id === oneShotSourceId)) {
    throw new Error("Feed single source not in approved registry");
  }
  if (nasaReviewEnabled) {
    if (oneShotSourceId !== "nasa_news") {
      throw new Error("NASA response scope requires NASA-only selection");
    }
    const selected = sources.find((source) => source.id === oneShotSourceId);
    if (!selected) throw new Error("NASA response source unavailable");
    feedResponseMaxBytes(selected, true);
  }
  function failed(sourceId: string, stage: FeedPollFailureStage): PollResult {
    try {
      onFailure?.(sourceId, stage);
    } catch {
      // Diagnostics may never alter a fail-closed poll result.
    }
    return { sourceId, status: "failed", newItems: 0 };
  }
  return {
    async poll(now: Date): Promise<readonly PollResult[]> {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error("Feed poll clock invalid");
      }
      const results: PollResult[] = [];
      for (const source of sources) {
        // An operator-selected one-shot source is a subset of the complete,
        // independently reviewed signed registry. Other sources get no
        // authority query, SQL lease, DNS lookup or outbound HTTPS request.
        if (oneShotSourceId !== undefined && source.id !== oneShotSourceId) continue;
        // Never consume a poll lease or contact HTTPS for a stale/revoked
        // snapshot. An unavailable authority is a per-source failure.
        if (authority) {
          try {
            if (!(await authority.admitted(source))) {
              throw new Error("Source authorization rejected");
            }
          } catch {
            results.push(failed(source.id, "source_grant"));
            continue;
          }
        }
        let lease: FeedPollLease | null;
        try {
          lease = await store.claim(source.id, now, source.intervalMinutes);
        } catch {
          results.push(failed(source.id, "lease_claim"));
          continue;
        }
        if (!lease) continue;
        let stage: FeedPollFailureStage = "lease_validation";
        try {
          if (
            typeof lease.token !== "string" ||
            !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(lease.token)
          ) {
            throw new Error("Feed lease token invalid");
          }
          const validators = {
            etag: safeValidator(lease.validators.etag),
            lastModified: safeValidator(lease.validators.lastModified),
          };
          // A revocation may have occurred while claiming the lease.
          stage = "source_grant_before_https";
          if (authority && !(await authority.admitted(source))) {
            throw new Error("Source authorization revoked");
          }
          stage = "https_transport";
          const result = await transport.request(source, validators);
          if (result.status === 304) {
            if (result.body !== "") throw new Error("Not-modified payload refused");
            results.push({ sourceId: source.id, status: "not_modified", newItems: 0 });
            continue;
          }
          stage = "feed_decode";
          let items: readonly FeedItem[];
          try {
            items = decodeApprovedFeed(source, registry, result, nasaReviewEnabled);
          } catch (error) {
            // Only after the unchanged decoder rejects EVERY metadata item.
            // This reuses the response already in memory and never issues a GET.
            if (
              onRejectedMetadata &&
              classifyFeedDecodeRefusal(error) === "no_approved_metadata"
            ) {
              try {
                onRejectedMetadata(source.id, summarizeFeedMetadataRejections(source, registry, result));
              } catch {
                // Diagnostics cannot accept metadata or change the original refusal.
              }
            }
            throw error;
          }
          // Never voluntarily persist metadata after the current authority
          // has rejected this source. SQL-side atomic commit admission is a
          // separate prerequisite for a fully race-free production guarantee.
          stage = "source_grant_before_commit";
          if (authority && !(await authority.admitted(source))) {
            throw new Error("Source authorization revoked");
          }
          stage = "metadata_commit";
          const written = await store.commit(source.id, lease.token, items, {
            etag: safeValidator(result.etag),
            lastModified: safeValidator(result.lastModified),
          });
          if (!Number.isSafeInteger(written) || written < 0 || written > items.length) {
            throw new Error("Feed persistence result invalid");
          }
          results.push({ sourceId: source.id, status: "ingested", newItems: written });
        } catch (error) {
          if (stage === "feed_decode") {
            try {
              onDecodeRefusal?.(source.id, classifyFeedDecodeRefusal(error));
            } catch {
              // Diagnostic callbacks must never change failure or persist metadata.
            }
          }
          // Suppress raw URL, XML, response and transport errors.
          results.push(failed(source.id, stage));
        }
      }
      return results;
    },
  };
}
