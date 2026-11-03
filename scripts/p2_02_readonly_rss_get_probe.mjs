import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APPROVED_HOSTS = Object.freeze({
  nasa_news: "www.nasa.gov",
  noaa_news: "www.noaa.gov",
  usgs_news: "www.usgs.gov",
});
const REFUSED = "Read-only RSS GET probe refused";
const TRANSPORT_REASONS = new Set([
  "dns_unavailable",
  "dns_address_refused",
  "https_unavailable",
  "request_timeout",
  "http_status_refused",
  "response_size_refused",
  "response_stream_refused",
  "response_compression_refused",
  "response_framing_refused",
  "response_header_refused",
  "response_media_type_refused",
  "response_utf8_refused",
  "response_304_body_refused",
]);
const DECODE_REASONS = new Map([
  ["Feed XML unsafe", "unsafe_xml"],
  ["Feed XML envelope invalid", "xml_envelope_invalid"],
  ["Feed item limit exceeded", "too_many_items"],
  ["Feed has no supported items", "no_supported_items"],
  ["Feed has no approved metadata", "no_approved_metadata"],
  ["Feed media type refused", "media_type_refused"],
  ["Feed response invalid", "response_invalid"],
]);

function exactFields(input, names) {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === names.length &&
    names.every((name) => Object.hasOwn(input, name))
  );
}

/**
 * Input must be the existing operator-approved full registry snapshot.
 * This diagnostic never enrolls or changes sources and cannot accept
 * arbitrary hostnames, URLs, IDs or an additional approved source.
 */
export function validatedReadOnlyGetRegistry(raw, parseRegistry, approvedSourceForUrl) {
  if (!exactFields(raw, ["version", "sources"]) || raw.version !== 1) {
    throw new Error(REFUSED);
  }
  const policy = { enabled: true, hosts: Object.values(APPROVED_HOSTS) };
  let registry;
  try {
    registry = parseRegistry(JSON.stringify(raw), policy);
  } catch {
    throw new Error(REFUSED);
  }
  const approved = registry.filter((source) => source.status === "approved");
  if (approved.length !== 3) throw new Error(REFUSED);
  const seen = new Set();
  for (const source of approved) {
    if (
      !Object.hasOwn(APPROVED_HOSTS, source.id) ||
      seen.has(source.id) ||
      source.access !== "rss" ||
      source.usage !== "metadata_only" ||
      approvedSourceForUrl(source.baseUrl, registry)?.id !== source.id
    ) {
      throw new Error(REFUSED);
    }
    const target = new URL(source.feedUrl ?? source.baseUrl);
    const scope = new URL(source.baseUrl);
    if (
      target.protocol !== "https:" ||
      target.hostname !== APPROVED_HOSTS[source.id] ||
      scope.hostname !== target.hostname ||
      target.port ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      target.pathname.includes("%") ||
      target.toString() !== (source.feedUrl ?? source.baseUrl)
    ) {
      throw new Error(REFUSED);
    }
    seen.add(source.id);
  }
  return {
    registry,
    approved: approved.sort((a, b) => a.id.localeCompare(b.id, "en")),
    policy,
  };
}

function safeDecodeReason(error) {
  const message = error instanceof Error ? error.message : null;
  return DECODE_REASONS.get(message) ?? "other";
}

/**
 * One bounded, unconditional GET per approved source, no database or queue.
 * The injected transport in production is the identical pinned/no-redirect
 * HTTPS transport used by the worker. Never log feed XML, links or titles.
 */
export async function runReadOnlyRssGetProbe(
  validated,
  transport,
  decodeApprovedFeed,
  failures = new Map(),
) {
  const report = [];
  for (const source of validated.approved) {
    let response;
    try {
      response = await transport.request(source, { etag: null, lastModified: null });
    } catch {
      const detail = failures.get(source.id);
      const kind =
        detail && typeof detail === "object" && TRANSPORT_REASONS.has(detail.kind)
          ? detail.kind
          : "unclassified";
      const httpStatus =
        kind === "http_status_refused" &&
        Number.isInteger(detail?.httpStatus) &&
        detail.httpStatus >= 100 &&
        detail.httpStatus <= 599
          ? detail.httpStatus
          : undefined;
      report.push({
        sourceId: source.id,
        stage: "https_or_http_refused",
        refusal: kind,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
      continue;
    }
    if (response.status !== 200) {
      report.push({ sourceId: source.id, stage: "unexpected_not_modified" });
      continue;
    }
    try {
      const items = decodeApprovedFeed(source, validated.registry, response);
      report.push({
        sourceId: source.id,
        stage: "metadata_accepted",
        httpStatus: 200,
        mediaType: response.mediaType,
        parser: "project_decoder_accepted",
        approvedArticleUrls: items.length,
      });
    } catch (error) {
      report.push({
        sourceId: source.id,
        stage: "metadata_refused",
        reason: safeDecodeReason(error),
      });
    }
  }
  return report;
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--inspect-only") {
    throw new Error(REFUSED);
  }
  let contents = "";
  for await (const chunk of process.stdin) {
    contents += chunk.toString("utf8");
    if (Buffer.byteLength(contents, "utf8") > 32768) throw new Error(REFUSED);
  }
  const raw = JSON.parse(contents);
  const location = (name) => pathToFileURL(resolve(process.cwd(), "apps/worker/dist", name)).href;
  const { parseReviewedSourceRegistry, approvedSourceForUrl } = await import(
    location("source-registry.js")
  );
  const { createPinnedFeedHttpsTransport } = await import(location("feed-https-transport.js"));
  const { decodeApprovedFeed } = await import(location("feed-poller.js"));
  const validated = validatedReadOnlyGetRegistry(
    raw,
    parseReviewedSourceRegistry,
    approvedSourceForUrl,
  );
  const failures = new Map();
  const transport = createPinnedFeedHttpsTransport(validated.registry, validated.policy, {
    onRefusal(sourceId, refusal) {
      failures.set(sourceId, refusal);
    },
  });
  const report = await runReadOnlyRssGetProbe(validated, transport, decodeApprovedFeed, failures);
  for (const result of report) console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(REFUSED);
    process.exitCode = 1;
  });
}
