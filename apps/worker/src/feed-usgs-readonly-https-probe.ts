import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import {
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  closeSync,
  lstatSync,
} from "node:fs";
import { approvedSourceForUrl } from "./source-registry.js";
import { verifyDormantSourceSignature } from "./source-export-signature.js";
import {
  createPinnedFeedHttpsTransport,
  productionFeedHttpsDependencies,
} from "./feed-https-transport.js";
import type { FeedHttpsDependencies, FeedHttpsRefusal } from "./feed-https-transport.js";
import {
  decodeApprovedFeed,
  summarizeFeedMetadataRejections,
  previewRejectedFeedTrackingQueries,
} from "./feed-poller.js";
import type { FeedLinkRejectionReasons, RejectedFeedTrackingQueryPreview } from "./feed-poller.js";
import { readPinnedFeedTrustFile } from "./feed-runtime-protected-files.js";

const REFUSED = "USGS read-only HTTPS diagnostic refused";
const INBOX = "/var/lib/vns/feed-source-inbox";
const CHECKPOINT = "/var/lib/vns/feed-source-checkpoint";
const PUBLIC_KEY = "/run/secrets/vns_feed_source_public_key";
const HOSTS = ["www.nasa.gov", "www.noaa.gov", "www.usgs.gov"] as const;
const USGS_BASE = "https://www.usgs.gov/news/";
const USGS_FEED = "https://www.usgs.gov/news/149248/feed";
const ACK = "ONE_READ_ONLY_USGS_HTTPS_GET_DIAGNOSTIC_ONLY";
const SHA256 = /^[a-f0-9]{64}$/;
const REASONS = new Set([
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
const PARSER_REASONS = new Map([
  ["Feed XML unsafe", "unsafe_xml"],
  ["Feed XML envelope invalid", "xml_envelope_invalid"],
  ["Feed item limit exceeded", "too_many_items"],
  ["Feed has no supported items", "no_supported_items"],
  ["Feed has no approved metadata", "no_approved_metadata"],
  ["Feed media type refused", "media_type_refused"],
  ["Feed response invalid", "response_invalid"],
]);

type SafeReport =
  | {
      scope: "usgs_single_readonly_get";
      sourceId: "usgs_news";
      stage: "metadata_accepted";
      approvedArticleUrls: number;
    }
  | {
      scope: "usgs_single_readonly_get";
      sourceId: "usgs_news";
      stage: "metadata_refused";
      reason: string;
      rejectionCounts?: {
        scanned: number;
        outsideApprovedPrefix: number;
        invalidOrBlockedLink: number;
        linkFailureReasons: FeedLinkRejectionReasons;
        trackingQueryPreview?: RejectedFeedTrackingQueryPreview;
        invalidHeadline: number;
        invalidPublishedAt: number;
        duplicate: number;
      };
    }
  | {
      scope: "usgs_single_readonly_get";
      sourceId: "usgs_news";
      stage: "https_or_http_refused";
      refusal: string;
      httpStatus?: number;
      phase?: string;
      bodySizeBand?: string;
      declaredLengthBand?: string;
    };

function admitted(env: NodeJS.ProcessEnv): void {
  if (
    env.VNS_P2_USGS_GET_DIAGNOSTIC_ENABLED !== "true" ||
    env.VNS_P2_USGS_GET_DIAGNOSTIC_ACK !== ACK ||
    env.VNS_SOURCE_FETCH_ENABLED !== "true" ||
    env.VNS_ALLOWED_SOURCE_HOSTS !== HOSTS.join(",") ||
    env.VNS_FEED_RUNTIME_ENABLED === "true" ||
    env.VNS_FEED_CANARY_SOURCE_ID ||
    env.VNS_FEED_SOURCE_BOOTSTRAP === "true"
  ) {
    throw new Error(REFUSED);
  }
}

function fixedRefusal(detail: FeedHttpsRefusal | undefined): SafeReport {
  const report: SafeReport = {
    scope: "usgs_single_readonly_get",
    sourceId: "usgs_news",
    stage: "https_or_http_refused",
    refusal: detail && REASONS.has(detail.kind) ? detail.kind : "unclassified",
  };
  if (
    report.refusal === "http_status_refused" &&
    Number.isInteger(detail?.httpStatus) &&
    detail?.httpStatus !== undefined &&
    detail.httpStatus >= 100 &&
    detail.httpStatus <= 599
  )
    report.httpStatus = detail.httpStatus;
  if (detail?.phase === "before_headers" || detail?.phase === "response_body") {
    report.phase = detail.phase;
  }
  if (
    detail?.bodySizeBand === "zero" ||
    detail?.bodySizeBand === "under_limit" ||
    detail?.bodySizeBand === "over_limit"
  )
    report.bodySizeBand = detail.bodySizeBand;
  if (
    detail?.declaredLengthBand === "missing" ||
    detail?.declaredLengthBand === "under_limit" ||
    detail?.declaredLengthBand === "over_limit" ||
    detail?.declaredLengthBand === "invalid"
  )
    report.declaredLengthBand = detail.declaredLengthBand;
  return report;
}

/**
 * Offline-testable boundary: verifies the existing Ed25519-signed 10/10 bundle,
 * matching private checkpoint, exact 3-source scope and the one USGS URL
 * before making at most one GET using the production DNS-pinned transport.
 * No SQL, Redis, queue, checkpoint writes, scheduler or publication.
 */
export async function probeUsGsOneGet(
  env: NodeJS.ProcessEnv,
  signedBytes: string,
  checkpointBytes: string,
  publicKey: KeyObject,
  dependencies: Partial<FeedHttpsDependencies> = {},
): Promise<SafeReport> {
  admitted(env);
  if (
    Buffer.byteLength(signedBytes, "utf8") > 49152 ||
    Buffer.byteLength(checkpointBytes, "utf8") > 49152 ||
    signedBytes.length < 2 ||
    checkpointBytes.length < 2
  )
    throw new Error(REFUSED);

  const signed = JSON.parse(signedBytes) as unknown;
  const check = JSON.parse(checkpointBytes) as Record<string, unknown>;
  if (
    !check ||
    typeof check !== "object" ||
    Array.isArray(check) ||
    Object.keys(check).length !== 4 ||
    check.version !== 1 ||
    check.sourceRevision !== 10 ||
    check.hostApprovalRevision !== 10 ||
    typeof check.envelopeSha256 !== "string" ||
    !SHA256.test(check.envelopeSha256) ||
    check.envelopeSha256 !== createHash("sha256").update(signedBytes, "utf8").digest("hex")
  )
    throw new Error(REFUSED);

  const policy = { enabled: true as const, hosts: [...HOSTS] };
  const verified = verifyDormantSourceSignature(signed, policy, publicKey, {
    sourceRevision: 10,
    hostApprovalRevision: 10,
  });
  if (
    verified.sealed.export.sourceRevision !== 10 ||
    verified.sealed.export.hostApprovalRevision !== 10 ||
    verified.sources.length !== 3 ||
    verified.sources.some(
      (source) =>
        !["nasa_news", "noaa_news", "usgs_news"].includes(source.id) ||
        source.status !== "approved" ||
        source.access !== "rss" ||
        source.usage !== "metadata_only",
    )
  )
    throw new Error(REFUSED);
  const source = verified.sources.find((entry) => entry.id === "usgs_news");
  if (
    !source ||
    source.baseUrl !== USGS_BASE ||
    source.feedUrl !== USGS_FEED ||
    approvedSourceForUrl(USGS_BASE, verified.sources)?.id !== "usgs_news"
  )
    throw new Error(REFUSED);

  let refusal: FeedHttpsRefusal | undefined;
  const transport = createPinnedFeedHttpsTransport(verified.sources, policy, {
    ...productionFeedHttpsDependencies(),
    ...dependencies,
    onRefusal(id, detail) {
      if (id === "usgs_news") refusal = detail;
    },
  });
  let response;
  try {
    response = await transport.request(source, { etag: null, lastModified: null });
  } catch {
    return fixedRefusal(refusal);
  }
  if (response.status !== 200) return fixedRefusal(undefined);
  try {
    const items = decodeApprovedFeed(source, verified.sources, response);
    return {
      scope: "usgs_single_readonly_get",
      sourceId: "usgs_news",
      stage: "metadata_accepted",
      approvedArticleUrls: items.length,
    };
  } catch (error) {
    const reason = PARSER_REASONS.get(error instanceof Error ? error.message : "") ?? "other";
    // Only an already rejected response is inspected; no second HTTPS GET.
    // The original decoder and every rejection rule are unchanged.
    let rejectionCounts: Extract<SafeReport, { stage: "metadata_refused" }>["rejectionCounts"];
    if (reason === "no_approved_metadata") {
      try {
        const tally = summarizeFeedMetadataRejections(source, verified.sources, response);
        if (tally.scanned > 0 && tally.scanned <= 20 && tally.accepted === 0) {
          rejectionCounts = {
            scanned: tally.scanned,
            outsideApprovedPrefix: tally.outsideApprovedPrefix,
            invalidOrBlockedLink: tally.invalidOrBlockedLink,
            linkFailureReasons: tally.linkFailureReasons,
            invalidHeadline: tally.invalidHeadline,
            invalidPublishedAt: tally.invalidPublishedAt,
            duplicate: tally.duplicate,
          };
          if (tally.linkFailureReasons.queryString > 0) {
            try {
              rejectionCounts.trackingQueryPreview = previewRejectedFeedTrackingQueries(
                source,
                verified.sources,
                response,
              );
            } catch {
              // A preview failure cannot weaken the original refusal.
            }
          }
        }
      } catch {
        // No diagnostic failure may change the original fail-closed refusal.
      }
    }
    return {
      scope: "usgs_single_readonly_get",
      sourceId: "usgs_news",
      stage: "metadata_refused",
      reason,
      ...(rejectionCounts === undefined ? {} : { rejectionCounts }),
    };
  }
}

/** Read only existing restricted worker files; never open the publisher key. */
function privateRead(dir: string, name: string): string {
  const stat = lstatSync(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== 10002 ||
    stat.gid !== 10002 ||
    (stat.mode & 0o777) !== 0o700 ||
    realpathSync(dir) !== dir ||
    process.getuid?.() !== 10002 ||
    process.getgid?.() !== 10002
  )
    throw new Error(REFUSED);
  const path = dir + "/" + name;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== 10002 ||
      before.gid !== 10002 ||
      (before.mode & 0o777) !== 0o600 ||
      before.size < 2 ||
      before.size > 49152 ||
      realpathSync(path) !== path
    )
      throw new Error(REFUSED);
    const bytes = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (
      Buffer.byteLength(bytes, "utf8") !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error(REFUSED);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1]?.endsWith("/feed-usgs-readonly-https-probe.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--inspect-usgs-only") {
    console.error(REFUSED);
    process.exitCode = 2;
  } else {
    try {
      admitted(process.env);
      const key = createPublicKey(readPinnedFeedTrustFile(PUBLIC_KEY));
      const result = await probeUsGsOneGet(
        process.env,
        privateRead(INBOX, "source-export.signed.json"),
        privateRead(CHECKPOINT, "source-export.checkpoint.json"),
        key,
      );
      console.log(JSON.stringify(result));
      if (result.stage !== "metadata_accepted") process.exitCode = 1;
    } catch {
      console.error(REFUSED);
      process.exitCode = 1;
    }
  }
}
