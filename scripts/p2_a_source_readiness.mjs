import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ID = /^[a-z][a-z0-9_-]{2,40}$/;
const HTTPS = /^https:\/\/[a-z0-9.-]+(?::443)?\/[a-zA-Z0-9/._~-]*$/;

function canonicalHttps(value) {
  if (typeof value !== "string" || !HTTPS.test(value)) return null;
  try {
    const url = new URL(value);
    return url.toString() === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !url.port &&
      url.hostname.includes(".") &&
      !url.hostname.endsWith(".local") &&
      !url.hostname.endsWith(".internal") &&
      !url.hostname.endsWith(".localhost") &&
      !/^(?:[0-9]+\.){3}[0-9]+$/.test(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

/**
 * A documented candidate is NOT an approved source or a feed credential.
 * Migration 0050 supports independently reviewed, same-host feedUrl and
 * article baseUrl: do not mistake different paths for incompatibility.
 * The script never changes a registry or authorizes any live feed request.
 */
export function assessOfficialFeedProposals(document) {
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.version !== 1 ||
    document.admission !== "pending_operator_review" ||
    !Array.isArray(document.proposals) ||
    document.proposals.length < 3 ||
    document.proposals.length > 5
  )
    throw new Error("Source proposal input invalid");
  const ids = new Set();
  const groups = new Set();
  const results = [];
  for (const source of document.proposals) {
    if (
      !source ||
      typeof source !== "object" ||
      Array.isArray(source) ||
      typeof source.id !== "string" ||
      !ID.test(source.id) ||
      ids.has(source.id) ||
      typeof source.publisherGroup !== "string" ||
      !ID.test(source.publisherGroup) ||
      source.access !== "rss" ||
      source.usage !== "metadata_only" ||
      source.rightsStatus !== "pending" ||
      typeof source.notes !== "string" ||
      source.notes.length < 30 ||
      !canonicalHttps(source.rightsReference) ||
      !canonicalHttps(source.feedReference)
    )
      throw new Error("Unreviewed source record invalid");
    const feed = canonicalHttps(source.feedUrl);
    const article = canonicalHttps(source.articleScope);
    if (!feed || !article || !article.pathname.endsWith("/")) {
      throw new Error("Source feed or article scope invalid");
    }
    ids.add(source.id);
    groups.add(source.publisherGroup);
    const reasons = [];
    // Since migration 0050, the exact feedUrl may be a file or a sibling
    // path of baseUrl. The registry still requires a same-host URL, and
    // feedUrl=baseUrl must not be supplied as an optional exact endpoint.
    if (feed.hostname !== article.hostname) reasons.push("feed_article_host_mismatch");
    if (feed.href === article.href) reasons.push("feed_url_equals_article_scope");
    // Neither compatibility nor public-domain agency guidance is a personal
    // source/host grant or proof of per-item publication rights.
    const compatibleWithCurrentRegistry = reasons.length === 0;
    reasons.push("operator_legal_and_host_review_missing");
    reasons.push("per_item_rights_and_attribution_unverified");
    reasons.push("live_feed_response_unverified");
    results.push({
      id: source.id,
      publisherGroup: source.publisherGroup,
      compatibleWithCurrentRegistry,
      reasons,
      approvedForLive: false,
    });
  }
  if (groups.size !== ids.size) {
    throw new Error("Candidate sources must have distinct declared publishers");
  }
  return {
    proposals: results,
    approvedForLive: false,
    currentRegistryReady: results.every((item) => item.compatibleWithCurrentRegistry),
    nextStep:
      "Separate same-host feedUrl and article baseUrl are supported since 0050; verify feed response, per-item rights, and personal operator/host approvals before any live polling",
  };
}

export function readOfficialFeedProposals() {
  const path = fileURLToPath(
    new URL("../docs/p2-a-official-source-candidates.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--inspect") {
    console.error("Read-only inspection requires --inspect");
    process.exitCode = 2;
  } else {
    const result = assessOfficialFeedProposals(readOfficialFeedProposals());
    console.log(JSON.stringify(result, null, 2));
    if (!result.currentRegistryReady || !result.approvedForLive) process.exitCode = 1;
  }
}
