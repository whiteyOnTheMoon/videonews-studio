import { approvedSourceForUrl, type RegisteredResearchSource } from "./source-registry.js";
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

const MAX_FEED_CHARS = 131072;
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
  if (url.toString() !== value || url.pathname.includes("%")) return null;
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
    if (records.length >= MAX_ITEMS) throw new Error("Feed item limit exceeded");
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
): readonly FeedItem[] {
  if (
    response.status !== 200 ||
    typeof response.body !== "string" ||
    response.body.length < 1 ||
    Buffer.byteLength(response.body, "utf8") > MAX_FEED_CHARS
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
  return {
    async poll(now: Date): Promise<readonly PollResult[]> {
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error("Feed poll clock invalid");
      }
      const results: PollResult[] = [];
      for (const source of sources) {
        let lease: FeedPollLease | null;
        try {
          lease = await store.claim(source.id, now, source.intervalMinutes);
        } catch {
          results.push({ sourceId: source.id, status: "failed", newItems: 0 });
          continue;
        }
        if (!lease) continue;
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
          const result = await transport.request(source, validators);
          if (result.status === 304) {
            if (result.body !== "") throw new Error("Not-modified payload refused");
            results.push({ sourceId: source.id, status: "not_modified", newItems: 0 });
            continue;
          }
          const items = decodeApprovedFeed(source, registry, result);
          const written = await store.commit(source.id, lease.token, items, {
            etag: safeValidator(result.etag),
            lastModified: safeValidator(result.lastModified),
          });
          if (!Number.isSafeInteger(written) || written < 0 || written > items.length) {
            throw new Error("Feed persistence result invalid");
          }
          results.push({ sourceId: source.id, status: "ingested", newItems: written });
        } catch {
          // Suppress raw URL, XML, response and transport errors.
          results.push({ sourceId: source.id, status: "failed", newItems: 0 });
        }
      }
      return results;
    },
  };
}
