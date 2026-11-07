import { lookup } from "node:dns/promises";
import https from "node:https";
import {
  createPinnedHttpsOptions,
  isPublicIPv4,
  type ApprovedFetchPolicy,
} from "./source-fetch.js";
import { approvedSourceForUrl, type RegisteredResearchSource } from "./source-registry.js";
import {
  DEFAULT_FEED_MAX_BYTES,
  NASA_REVIEW_FEED_URL,
  NASA_REVIEW_MAX_BYTES,
  feedResponseMaxBytes,
} from "./feed-nasa-bounded-response.js";
import type { FeedResponse, FeedTransport, FeedValidators } from "./feed-poller.js";

const MAX_BYTES = DEFAULT_FEED_MAX_BYTES;
const TIMEOUT_MS = 5000;

interface WireReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Optional operator-only fixed-code reporting; never used for normal worker logs. */
export type FeedHttpsRefusalKind =
  | "dns_unavailable"
  | "dns_address_refused"
  | "https_unavailable"
  | "request_timeout"
  | "http_status_refused"
  | "response_size_refused"
  | "response_stream_refused"
  | "response_compression_refused"
  | "response_framing_refused"
  | "response_header_refused"
  | "response_media_type_refused"
  | "response_utf8_refused"
  | "response_304_body_refused";

export type FeedHttpsFailurePhase = "before_headers" | "response_body";
export type FeedHttpsBodySizeBand = "zero" | "under_limit" | "over_limit";
export type FeedHttpsDeclaredLengthBand = "missing" | "under_limit" | "over_limit" | "invalid";

export interface FeedHttpsRefusal {
  kind: FeedHttpsRefusalKind;
  phase?: FeedHttpsFailurePhase;
  bodySizeBand?: FeedHttpsBodySizeBand;
  declaredLengthBand?: FeedHttpsDeclaredLengthBand;
  /** Exact numeric status only for a rejected HTTP response, never a Location header. */
  httpStatus?: number;
}

type StreamDetails = Pick<FeedHttpsRefusal, "phase" | "bodySizeBand" | "declaredLengthBand">;

export interface FeedHttpsDependencies {
  resolveIPv4(hostname: string): Promise<string[]>;
  requestPinned(
    url: URL,
    address: string,
    requestHeaders: Record<string, string>,
    diagnose?: (kind: FeedHttpsRefusalKind, httpStatus?: number, details?: StreamDetails) => void,
    maxBytes?: number,
  ): Promise<WireReply>;
  /** Diagnostic side channel: fixed labels only, no raw HTTP/Node errors. */
  onRefusal?: (sourceId: string, refusal: FeedHttpsRefusal) => void;
}

const TYPES: Readonly<Record<string, readonly string[]>> = {
  rss: ["application/rss+xml", "application/xml", "text/xml"],
  atom: ["application/atom+xml", "application/xml", "text/xml"],
  official_api: ["application/json"],
};

function header(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new Error("Feed response header refused");
  }
  if (
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error("Feed response header refused");
  }
  return value;
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Feed deadline exceeded")), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolvePublic(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, family: 4 });
  return results.map((result) => result.address);
}

function requestPinned(
  url: URL,
  address: string,
  conditionalHeaders: Record<string, string>,
  diagnose?: (kind: FeedHttpsRefusalKind, httpStatus?: number, details?: StreamDetails) => void,
  maxBytes: number = MAX_BYTES,
): Promise<WireReply> {
  if (
    maxBytes !== MAX_BYTES &&
    (maxBytes !== NASA_REVIEW_MAX_BYTES || url.toString() !== NASA_REVIEW_FEED_URL)
  ) {
    return Promise.reject(new Error("Feed response limit refused"));
  }
  return new Promise((resolve, reject) => {
    const pinned = createPinnedHttpsOptions(url, address);
    let settled = false;
    let headersSeen = false;
    let size = 0;
    let declaredLengthBand: FeedHttpsDeclaredLengthBand = "missing";
    const phase = (): FeedHttpsFailurePhase => (headersSeen ? "response_body" : "before_headers");
    const sizeBand = (): FeedHttpsBodySizeBand => {
      if (size === 0) return "zero";
      return size > maxBytes ? "over_limit" : "under_limit";
    };
    const details = (): StreamDetails => ({
      phase: phase(),
      ...(headersSeen
        ? {
            bodySizeBand: sizeBand(),
            declaredLengthBand,
          }
        : {}),
    });
    const fail = (kind: FeedHttpsRefusalKind, status?: number) => {
      if (settled) return;
      settled = true;
      diagnose?.(kind, status, details());
      reject(new Error("Feed HTTPS retrieval refused"));
    };
    const req = https.request(
      {
        ...pinned,
        headers: {
          ...pinned.headers,
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json",
          ...conditionalHeaders,
        },
      },
      (res) => {
        headersSeen = true;
        const declared = res.headers["content-length"];
        declaredLengthBand =
          declared === undefined
            ? "missing"
            : typeof declared !== "string" || !/^(0|[1-9][0-9]*)$/.test(declared)
              ? "invalid"
              : Number(declared) > maxBytes
                ? "over_limit"
                : "under_limit";
        if (res.statusCode !== 200 && res.statusCode !== 304) {
          res.destroy();
          fail("http_status_refused", res.statusCode);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Report the size limit before destroying the response: destroy()
            // can synchronously emit "aborted" or "error", which must not
            // overwrite the primary fail-closed refusal.
            fail("response_size_refused");
            res.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        const failStream = () =>
          fail(pinned.signal?.aborted ? "request_timeout" : "response_stream_refused");
        res.on("error", failStream);
        res.on("aborted", failStream);
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              "content-type": res.headers["content-type"],
              "content-encoding": res.headers["content-encoding"],
              "content-length": res.headers["content-length"],
              etag: res.headers.etag,
              "last-modified": res.headers["last-modified"],
            },
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("timeout", () => {
      fail("request_timeout");
      req.destroy(new Error("Feed TLS timeout"));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      fail(error.code === "ABORT_ERR" ? "request_timeout" : "https_unavailable");
    });
    req.end();
  });
}

/**
 * Dormant, DNS-pinned HTTPS transport. It can only fetch an exact approved
 * registry entry, never an arbitrary link found in a feed or an HTTP redirect.
 * Not injected into the running scheduler/worker.
 */
export function createPinnedFeedHttpsTransport(
  registry: readonly RegisteredResearchSource[],
  policy: ApprovedFetchPolicy,
  dependencies: Partial<FeedHttpsDependencies> = {},
  nasaReviewEnabled = false,
): FeedTransport {
  if (policy.enabled !== true || !Array.isArray(policy.hosts) || policy.hosts.length < 1) {
    throw new Error("Feed transport requires explicitly approved host policy");
  }
  if (nasaReviewEnabled) {
    const selected = registry.find((source) => source.id === "nasa_news");
    if (!selected || feedResponseMaxBytes(selected, true) !== NASA_REVIEW_MAX_BYTES) {
      throw new Error("NASA extended response source unavailable");
    }
  }
  const resolve = dependencies.resolveIPv4 ?? resolvePublic;
  const request = dependencies.requestPinned ?? requestPinned;
  return {
    async request(
      source: RegisteredResearchSource,
      validators: FeedValidators,
    ): Promise<FeedResponse> {
      let reported = false;
      const diagnose = (
        kind: FeedHttpsRefusalKind,
        httpStatus?: number,
        details?: StreamDetails,
      ): void => {
        if (reported) return;
        reported = true;
        // Never expose the raw header value, URL, IP, response bytes or error.
        const refusal: FeedHttpsRefusal = { kind };
        if (
          kind === "http_status_refused" &&
          Number.isInteger(httpStatus) &&
          httpStatus !== undefined &&
          httpStatus >= 100 &&
          httpStatus <= 599
        ) {
          refusal.httpStatus = httpStatus;
        }
        // Whitelist each field independently: the callback is never an object spread.
        if (details?.phase === "before_headers" || details?.phase === "response_body") {
          refusal.phase = details.phase;
        }
        if (
          details?.bodySizeBand === "zero" ||
          details?.bodySizeBand === "under_limit" ||
          details?.bodySizeBand === "over_limit"
        ) {
          refusal.bodySizeBand = details.bodySizeBand;
        }
        if (
          details?.declaredLengthBand === "missing" ||
          details?.declaredLengthBand === "under_limit" ||
          details?.declaredLengthBand === "over_limit" ||
          details?.declaredLengthBand === "invalid"
        ) {
          refusal.declaredLengthBand = details.declaredLengthBand;
        }
        try {
          dependencies.onRefusal?.(source.id, refusal);
        } catch {
          // Diagnostic errors must not weaken admission or change the result.
        }
      };
      // Require exact registry identity and approved most-specific URL scope.
      const approved = registry.find((item) => item.id === source.id);
      if (
        !approved ||
        approved.status !== "approved" ||
        source.status !== "approved" ||
        !["rss", "atom", "official_api"].includes(approved.access) ||
        approved.baseUrl !== source.baseUrl ||
        approved.feedUrl !== source.feedUrl ||
        approved.access !== source.access ||
        approved.intervalMinutes !== source.intervalMinutes ||
        approved.termsUrl !== source.termsUrl ||
        approved.usage !== source.usage ||
        approved.licenseNotes !== source.licenseNotes ||
        approved.reviewedAt !== source.reviewedAt ||
        approvedSourceForUrl(source.baseUrl, registry)?.id !== source.id
      ) {
        throw new Error("Feed source not approved");
      }
      const url = new URL(source.feedUrl ?? source.baseUrl);
      const scope = new URL(source.baseUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        url.toString() !== (source.feedUrl ?? source.baseUrl) ||
        !policy.hosts.includes(url.hostname) ||
        url.hostname !== scope.hostname ||
        url.pathname.includes("%")
      ) {
        throw new Error("Feed transport URL forbidden");
      }
      const maxBytes = feedResponseMaxBytes(approved, nasaReviewEnabled);
      let etag: string | null;
      let lastModified: string | null;
      try {
        etag = header(validators.etag);
        lastModified = header(validators.lastModified);
      } catch {
        throw new Error("Feed conditional headers invalid");
      }
      const conditional: Record<string, string> = {};
      if (etag) conditional["If-None-Match"] = etag;
      if (lastModified) conditional["If-Modified-Since"] = lastModified;

      let ips: string[];
      try {
        ips = await deadline(resolve(url.hostname));
      } catch {
        diagnose("dns_unavailable");
        throw new Error("Feed DNS resolution refused");
      }
      if (
        !Array.isArray(ips) ||
        ips.length < 1 ||
        ips.length > 16 ||
        !ips.every((ip) => isPublicIPv4(ip))
      ) {
        diagnose("dns_address_refused");
        throw new Error("Feed DNS address refused");
      }
      const pinned = ips[0];
      if (!pinned) {
        diagnose("dns_address_refused");
        throw new Error("Feed DNS address refused");
      }
      let response: WireReply;
      try {
        response = await deadline(request(url, pinned, conditional, diagnose, maxBytes));
      } catch {
        diagnose("https_unavailable");
        throw new Error("Feed HTTPS retrieval refused");
      }
      if (!Buffer.isBuffer(response.body) || response.body.length > maxBytes) {
        diagnose("response_size_refused");
        throw new Error("Feed response bytes refused");
      }
      const headers = response.headers;
      const encoding = headers["content-encoding"];
      if (encoding !== undefined && encoding !== "identity") {
        diagnose("response_compression_refused");
        throw new Error("Feed response compression forbidden");
      }
      const declared = headers["content-length"];
      if (
        declared !== undefined &&
        (typeof declared !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(declared) ||
          Number(declared) !== response.body.length)
      ) {
        diagnose("response_framing_refused");
        throw new Error("Feed response framing refused");
      }
      let validatorEtag: string | null;
      let validatorModified: string | null;
      try {
        validatorEtag = header(headers.etag);
        validatorModified = header(headers["last-modified"]);
      } catch {
        diagnose("response_header_refused");
        throw new Error("Feed response header refused");
      }
      if (response.status === 304) {
        if (response.body.length !== 0) {
          diagnose("response_304_body_refused");
          throw new Error("Feed 304 body refused");
        }
        return {
          status: 304,
          mediaType: null,
          body: "",
          etag: validatorEtag,
          lastModified: validatorModified,
        };
      }
      if (response.status !== 200) {
        diagnose("http_status_refused", response.status);
        throw new Error("Feed HTTP status refused");
      }
      const rawType = headers["content-type"];
      if (typeof rawType !== "string") {
        diagnose("response_media_type_refused");
        throw new Error("Feed media type refused");
      }
      const mediaType = rawType.split(";")[0]?.trim().toLowerCase();
      if (!mediaType || !(TYPES[source.access] ?? []).includes(mediaType)) {
        diagnose("response_media_type_refused");
        throw new Error("Feed media type refused");
      }
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      } catch {
        diagnose("response_utf8_refused");
        throw new Error("Feed response UTF-8 refused");
      }
      return {
        status: 200,
        mediaType,
        body,
        etag: validatorEtag,
        lastModified: validatorModified,
      };
    },
  };
}

/**
 * The real DNS-pinned HTTPS port is deliberately explicit. Only the separately
 * gated observation executable may inject it; no worker auto-starts a source.
 */
export function productionFeedHttpsDependencies(): FeedHttpsDependencies {
  return { resolveIPv4: resolvePublic, requestPinned };
}
