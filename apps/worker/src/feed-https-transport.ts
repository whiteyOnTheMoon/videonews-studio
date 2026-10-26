import { lookup } from "node:dns/promises";
import https from "node:https";
import {
  createPinnedHttpsOptions,
  isPublicIPv4,
  type ApprovedFetchPolicy,
} from "./source-fetch.js";
import { approvedSourceForUrl, type RegisteredResearchSource } from "./source-registry.js";
import type { FeedResponse, FeedTransport, FeedValidators } from "./feed-poller.js";

const MAX_BYTES = 131072;
const TIMEOUT_MS = 5000;

interface WireReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface FeedHttpsDependencies {
  resolveIPv4(hostname: string): Promise<string[]>;
  requestPinned(
    url: URL,
    address: string,
    requestHeaders: Record<string, string>,
  ): Promise<WireReply>;
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
): Promise<WireReply> {
  return new Promise((resolve, reject) => {
    const pinned = createPinnedHttpsOptions(url, address);
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
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
        if (res.statusCode !== 200 && res.statusCode !== 304) {
          res.destroy();
          fail();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            fail();
          } else {
            chunks.push(chunk);
          }
        });
        res.on("error", fail);
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
    req.on("timeout", () => req.destroy(new Error("Feed TLS timeout")));
    req.on("error", fail);
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
): FeedTransport {
  if (policy.enabled !== true || !Array.isArray(policy.hosts) || policy.hosts.length < 1) {
    throw new Error("Feed transport requires explicitly approved host policy");
  }
  const resolve = dependencies.resolveIPv4 ?? resolvePublic;
  const request = dependencies.requestPinned ?? requestPinned;
  return {
    async request(
      source: RegisteredResearchSource,
      validators: FeedValidators,
    ): Promise<FeedResponse> {
      // Require exact registry identity and approved most-specific URL scope.
      const approved = registry.find((item) => item.id === source.id);
      if (
        !approved ||
        approved.status !== "approved" ||
        source.status !== "approved" ||
        !["rss", "atom", "official_api"].includes(approved.access) ||
        approved.baseUrl !== source.baseUrl ||
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
      const url = new URL(source.baseUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        url.toString() !== source.baseUrl ||
        !policy.hosts.includes(url.hostname)
      ) {
        throw new Error("Feed transport URL forbidden");
      }
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
        throw new Error("Feed DNS resolution refused");
      }
      if (
        !Array.isArray(ips) ||
        ips.length < 1 ||
        ips.length > 16 ||
        !ips.every((ip) => isPublicIPv4(ip))
      ) {
        throw new Error("Feed DNS address refused");
      }
      const pinned = ips[0];
      if (!pinned) throw new Error("Feed DNS address refused");
      let response: WireReply;
      try {
        response = await deadline(request(url, pinned, conditional));
      } catch {
        throw new Error("Feed HTTPS retrieval refused");
      }
      if (!Buffer.isBuffer(response.body) || response.body.length > MAX_BYTES) {
        throw new Error("Feed response bytes refused");
      }
      const headers = response.headers;
      const encoding = headers["content-encoding"];
      if (encoding !== undefined && encoding !== "identity") {
        throw new Error("Feed response compression forbidden");
      }
      const declared = headers["content-length"];
      if (
        declared !== undefined &&
        (typeof declared !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(declared) ||
          Number(declared) !== response.body.length)
      ) {
        throw new Error("Feed response framing refused");
      }
      const validatorEtag = header(headers.etag);
      const validatorModified = header(headers["last-modified"]);
      if (response.status === 304) {
        if (response.body.length !== 0) throw new Error("Feed 304 body refused");
        return {
          status: 304,
          mediaType: null,
          body: "",
          etag: validatorEtag,
          lastModified: validatorModified,
        };
      }
      if (response.status !== 200) throw new Error("Feed HTTP status refused");
      const rawType = headers["content-type"];
      if (typeof rawType !== "string") throw new Error("Feed media type refused");
      const mediaType = rawType.split(";")[0]?.trim().toLowerCase();
      if (!mediaType || !(TYPES[source.access] ?? []).includes(mediaType)) {
        throw new Error("Feed media type refused");
      }
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      } catch {
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
