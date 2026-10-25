import { makeSourceCandidate, type SourceCandidateInput } from "./source-policy.js";
import type { ResearchCandidateProvider } from "./research-process.js";
import type { ApprovedFetchPolicy } from "./source-fetch.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure, fail-closed parsing of an operator-reviewed, exact-topic catalog.
 * Nothing is discovered automatically; content is never treated as verified.
 * The catalog is a required offline configuration file, not a public API input.
 */
export function parseApprovedResearchCatalog(
  input: string,
  policy: ApprovedFetchPolicy,
): ReadonlyMap<string, readonly SourceCandidateInput[]> {
  if (input.length < 1 || Buffer.byteLength(input, "utf8") > 32768) {
    throw new Error("Approved research catalog size refused");
  }
  if (policy.enabled !== true || policy.hosts.length < 1) {
    throw new Error("Source host approval required");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error("Approved research catalog JSON invalid");
  }
  if (
    !isObject(raw) ||
    Object.keys(raw).length !== 2 ||
    raw.version !== 1 ||
    !Array.isArray(raw.topics) ||
    raw.topics.length < 1 ||
    raw.topics.length > 10
  ) {
    throw new Error("Approved research catalog envelope invalid");
  }

  const entries = new Map<string, readonly SourceCandidateInput[]>();
  for (const item of raw.topics as unknown[]) {
    if (
      !isObject(item) ||
      Object.keys(item).length !== 2 ||
      typeof item.topic !== "string" ||
      item.topic.trim() !== item.topic ||
      item.topic.length < 12 ||
      item.topic.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(item.topic) ||
      entries.has(item.topic) ||
      !Array.isArray(item.candidates) ||
      item.candidates.length < 1 ||
      item.candidates.length > 3
    ) {
      throw new Error("Approved research catalog topic invalid");
    }
    const candidates = item.candidates.map((value: unknown): SourceCandidateInput => {
      const checked = makeSourceCandidate(value);
      // Research processor adds the candidate-only status after validation.
      return {
        sourceUrl: checked.sourceUrl,
        publisher: checked.publisher,
        headline: checked.headline,
        claim: checked.claim,
      };
    });
    const identities = new Set<string>();
    for (const candidate of candidates) {
      if (!policy.hosts.includes(new URL(candidate.sourceUrl).hostname)) {
        throw new Error("Research source host not approved");
      }
      const identity = JSON.stringify([candidate.sourceUrl, candidate.claim]);
      if (identities.has(identity)) throw new Error("Duplicate source candidate");
      identities.add(identity);
    }
    entries.set(item.topic, candidates);
  }
  return entries;
}

/** Exact topic lookup only: unknown jobs cannot trigger source discovery. */
export function createApprovedCatalogDiscovery(
  catalog: ReadonlyMap<string, readonly SourceCandidateInput[]>,
): ResearchCandidateProvider {
  return {
    async discover(topic: string): Promise<unknown> {
      const candidates = catalog.get(topic);
      if (!candidates?.length) throw new Error("Research topic not operator approved");
      return candidates;
    },
  };
}
