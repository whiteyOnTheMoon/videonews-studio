import { makeSourceCandidate, isPlausiblePublicSourceUrl } from "./source-policy.js";
import { createApprovedCatalogDiscovery } from "./research-catalog.js";
import type { ResearchCandidateProvider } from "./research-process.js";
import type { ApprovedFetchPolicy } from "./source-fetch.js";

export type SourceReviewStatus = "approved" | "pending" | "blocked";

export interface RegisteredResearchSource {
  id: string;
  baseUrl: string;
  status: SourceReviewStatus;
  access: "rss" | "atom" | "official_api" | "html";
  intervalMinutes: number;
  termsUrl: string;
  usage: "metadata_only" | "reviewed_excerpt";
  licenseNotes: string;
  reviewedAt: string;
}

const FIELDS = [
  "access",
  "baseUrl",
  "id",
  "intervalMinutes",
  "licenseNotes",
  "reviewedAt",
  "status",
  "termsUrl",
  "usage",
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function reviewedDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString().slice(0, 10) === value;
}

/**
 * Strict operator-managed registry, not a source discovery or RSS scheduler.
 * All entries must match the existing HTTPS host allowlist. No default sources.
 */
export function parseReviewedSourceRegistry(
  input: string,
  policy: ApprovedFetchPolicy,
): readonly RegisteredResearchSource[] {
  if (input.length < 1 || Buffer.byteLength(input, "utf8") > 32768) {
    throw new Error("Reviewed source registry size invalid");
  }
  if (policy.enabled !== true || !Array.isArray(policy.hosts) || policy.hosts.length < 1) {
    throw new Error("Reviewed source hosts not approved");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error("Reviewed source registry JSON invalid");
  }
  if (
    !record(raw) ||
    !exactFields(raw, ["version", "sources"]) ||
    raw.version !== 1 ||
    !Array.isArray(raw.sources) ||
    raw.sources.length < 1 ||
    raw.sources.length > 20
  ) {
    throw new Error("Reviewed source registry envelope invalid");
  }
  const ids = new Set<string>();
  const scopes = new Set<string>();
  const sources: RegisteredResearchSource[] = [];
  for (const value of raw.sources as unknown[]) {
    if (!record(value) || !exactFields(value, FIELDS)) {
      throw new Error("Reviewed source entry invalid");
    }
    const {
      id,
      baseUrl,
      status,
      access,
      intervalMinutes,
      termsUrl,
      usage,
      licenseNotes,
      reviewedAt,
    } = value;
    if (
      typeof id !== "string" ||
      !/^[a-z][a-z0-9_-]{2,40}$/.test(id) ||
      !isPlausiblePublicSourceUrl(baseUrl) ||
      !baseUrl.endsWith("/") ||
      !isPlausiblePublicSourceUrl(termsUrl) ||
      !["approved", "pending", "blocked"].includes(status as string) ||
      !["rss", "atom", "official_api", "html"].includes(access as string) ||
      !Number.isSafeInteger(intervalMinutes) ||
      (intervalMinutes as number) < 15 ||
      (intervalMinutes as number) > 10080 ||
      !["metadata_only", "reviewed_excerpt"].includes(usage as string) ||
      typeof licenseNotes !== "string" ||
      licenseNotes !== licenseNotes.trim() ||
      licenseNotes.length < 12 ||
      licenseNotes.length > 300 ||
      !reviewedDate(reviewedAt)
    ) {
      throw new Error("Reviewed source fields invalid");
    }
    const parsed = new URL(baseUrl);
    if (
      parsed.toString() !== baseUrl ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname.includes("%") ||
      !policy.hosts.includes(parsed.hostname) ||
      ids.has(id) ||
      scopes.has(baseUrl)
    ) {
      throw new Error("Reviewed source scope invalid");
    }
    ids.add(id);
    scopes.add(baseUrl);
    sources.push({
      id,
      baseUrl,
      status: status as SourceReviewStatus,
      access: access as RegisteredResearchSource["access"],
      intervalMinutes: intervalMinutes as number,
      termsUrl,
      usage: usage as RegisteredResearchSource["usage"],
      licenseNotes,
      reviewedAt,
    });
  }
  return sources;
}

/**
 * Longest matching URL scope wins, so a blocked child overrides an approved
 * parent. Fail closed for unknown, pending and blocked scopes.
 */
export function approvedSourceForUrl(
  sourceUrl: string,
  registry: readonly RegisteredResearchSource[],
): RegisteredResearchSource | null {
  if (!isPlausiblePublicSourceUrl(sourceUrl)) return null;
  const url = new URL(sourceUrl);
  if (url.toString() !== sourceUrl || url.pathname.includes("%")) return null;
  let match: RegisteredResearchSource | undefined;
  for (const source of registry) {
    const base = new URL(source.baseUrl);
    if (
      url.hostname === base.hostname &&
      url.pathname.startsWith(base.pathname) &&
      (!match || base.pathname.length > new URL(match.baseUrl).pathname.length)
    ) {
      match = source;
    }
  }
  return match?.status === "approved" ? match : null;
}

/** Drop unapproved candidates BEFORE research fetch or evidence persistence. */
export function createReviewedCatalogDiscovery(
  catalog: ReadonlyMap<string, readonly import("./source-policy.js").SourceCandidateInput[]>,
  registry: readonly RegisteredResearchSource[],
): ResearchCandidateProvider {
  const discovery = createApprovedCatalogDiscovery(catalog);
  return {
    async discover(topic: string): Promise<unknown> {
      const raw = await discovery.discover(topic);
      if (!Array.isArray(raw)) throw new Error("Research catalog candidates invalid");
      const approved = raw
        .map((candidate) => makeSourceCandidate(candidate))
        .filter((candidate) => approvedSourceForUrl(candidate.sourceUrl, registry) !== null)
        .map(({ sourceUrl, publisher, headline, claim }) => ({
          sourceUrl,
          publisher,
          headline,
          claim,
        }));
      if (approved.length < 1) throw new Error("No approved research sources for topic");
      return approved;
    },
  };
}
