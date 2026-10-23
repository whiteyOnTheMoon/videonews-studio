// Offline intake contract for future source connectors.
// NEVER fetch a URL merely because it passes these lexical checks; real HTTP
// fetching needs DNS/IP pinning, redirect restrictions, isolation and review.
import { isIP } from "node:net";

export interface SourceCandidateInput {
  sourceUrl: string;
  publisher: string;
  headline: string;
  claim: string;
}

export interface SourceCandidate extends SourceCandidateInput {
  reviewStatus: "candidate";
}

function plainText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const length = Array.from(value).length;
  return length >= min && length <= max &&
    !value.split("").some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    });
}

export function isPlausiblePublicSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512) return false;
  if (!value.startsWith("https://") || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.port || url.hash || isIP(url.hostname) !== 0) return false;
    const host = url.hostname.toLowerCase();
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host) ||
        host.endsWith(".local") || host.endsWith(".internal") ||
        host.endsWith(".localhost") || host.endsWith(".onion")) return false;
    return true;
  } catch {
    return false;
  }
}

export function makeSourceCandidate(input: unknown): SourceCandidate {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid source candidate");
  }
  const data = input as Record<string, unknown>;
  if (Object.keys(data).length !== 4 ||
      !isPlausiblePublicSourceUrl(data.sourceUrl) ||
      !plainText(data.publisher, 2, 120) ||
      !plainText(data.headline, 8, 200) ||
      !plainText(data.claim, 12, 280)) {
    throw new Error("Invalid source candidate");
  }
  // No source becomes verified by URL shape or candidate registration.
  return {
    sourceUrl: data.sourceUrl,
    publisher: data.publisher,
    headline: data.headline,
    claim: data.claim,
    reviewStatus: "candidate",
  };
}
