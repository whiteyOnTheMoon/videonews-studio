import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { isPlausiblePublicSourceUrl } from "./source-policy.js";

const MAX_BYTES = 131072; // 128 KiB; metadata inspection only, no archived article.
const TIMEOUT_MS = 5000;
const MEDIA_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
  "application/rss+xml",
  "application/atom+xml",
]);

export interface ApprovedFetchPolicy {
  enabled: true;
  hosts: readonly string[];
}

export interface SourceDocument {
  sourceUrl: string;
  fetchedAt: string;
  mediaType: string;
  sha256: string;
  text: string;
  // No 'verified' field: fetching is not evidence that a claim is true.
}

interface RawSourceResponse {
  status: number;
  contentType: string | undefined;
  contentEncoding: string | undefined;
  body: Buffer;
}

export interface SourceFetchDependencies {
  resolveIPv4: (host: string) => Promise<string[]>;
  requestPinned: (url: URL, ip: string) => Promise<RawSourceResponse>;
  now: () => Date;
}

function validHostname(host: string): boolean {
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host) || host.length > 253) return false;
  return !host.split(".").some((label) => label.length > 63 || label.startsWith("-") ||
    label.endsWith("-") || label.startsWith("xn--"));
}

export function readApprovedFetchPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ApprovedFetchPolicy {
  if (env.VNS_SOURCE_FETCH_ENABLED !== "true") {
    throw new Error("External source fetching is disabled");
  }
  const raw = env.VNS_ALLOWED_SOURCE_HOSTS ?? "";
  const hosts = raw.split(",").map((host) => host.trim());
  if (hosts.length < 1 || hosts.length > 5 ||
      hosts.some((host) => !validHostname(host) || host !== host.toLowerCase()) ||
      new Set(hosts).size !== hosts.length) {
    throw new Error("Explicit HTTPS source host allowlist required");
  }
  return { enabled: true, hosts };
}

/**
 * IPv4-only fail-closed filter: exclude loopback, LAN, carrier-grade NAT,
 * link-local, protocol/test ranges, multicast and reserved destinations.
 * Do not infer address safety from an HTTPS URL or an allowlisted DNS name.
 */
export function isPublicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const parts = address.split(".").map(Number);
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

function parseApprovedUrl(input: string, policy: ApprovedFetchPolicy): URL {
  if (!isPlausiblePublicSourceUrl(input)) throw new Error("Source URL denied");
  const url = new URL(input);
  if (url.toString() !== input || !validHostname(url.hostname) ||
      !policy.hosts.includes(url.hostname)) {
    throw new Error("Source host is not explicitly approved");
  }
  return url;
}

async function defaultResolveIPv4(host: string): Promise<string[]> {
  const addresses = await lookup(host, { all: true, family: 4 });
  return addresses.map(({ address }) => address);
}

export function createPinnedHttpsOptions(url: URL, address: string): https.RequestOptions {
  return {
    protocol: "https:",
    hostname: url.hostname,
    servername: url.hostname,
    port: 443,
    method: "GET",
    path: url.pathname + url.search,
    agent: false,
    rejectUnauthorized: true,
    timeout: TIMEOUT_MS,
    maxHeaderSize: 8192,
    headers: {
      Host: url.hostname,
      Accept: "text/html, text/plain, application/json, application/rss+xml, application/atom+xml",
      "Accept-Encoding": "identity",
      "User-Agent": "VideoNewsStudio-Research/0.1 (+offline-gated-source-review)",
    },
    // Network address is selected BEFORE opening the socket. TLS SNI and
    // certificate validation still target the original allowlisted hostname.
    lookup: (host, _opts, callback) => {
      if (host !== url.hostname) {
        callback(new Error("Unexpected DNS hostname"), "", 4);
        return;
      }
      callback(null, address, 4);
    },
  };
}

async function defaultPinnedRequest(url: URL, ip: string): Promise<RawSourceResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Approved source request rejected"));
    };
    const request = https.request(createPinnedHttpsOptions(url, ip), (response) => {
      if (response.statusCode !== 200) {
        // Never follow redirects to a second host or IP, even an approved URL.
        response.destroy();
        rejectOnce();
        return;
      }
      const contentType = response.headers["content-type"];
      const contentEncoding = response.headers["content-encoding"];
      const lengthHeader = response.headers["content-length"];
      if (typeof lengthHeader === "string" &&
          (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > MAX_BYTES)) {
        response.destroy();
        rejectOnce();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          response.destroy();
          rejectOnce();
        } else {
          chunks.push(chunk);
        }
      });
      response.on("error", rejectOnce);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          status: 200,
          contentType: typeof contentType === "string" ? contentType : undefined,
          contentEncoding: typeof contentEncoding === "string" ? contentEncoding : undefined,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Source timeout")));
    request.on("error", rejectOnce);
    request.end();
  });
}

/**
 * Secured bounded retrieval, NOT a research or fact-checking engine.
 * Dependencies are injectable for CI; production uses Node native TLS,
 * pinned DNS, no redirects, strict size/type limits and no raw error logging.
 */
export async function fetchApprovedSourceDocument(
  input: string,
  policy: ApprovedFetchPolicy,
  dependencies: Partial<SourceFetchDependencies> = {},
): Promise<SourceDocument> {
  if (policy.enabled !== true || !Array.isArray(policy.hosts)) {
    throw new Error("Source fetch must be approved");
  }
  const url = parseApprovedUrl(input, policy);
  const resolveIPv4 = dependencies.resolveIPv4 ?? defaultResolveIPv4;
  const requestPinned = dependencies.requestPinned ?? defaultPinnedRequest;
  let ips: string[];
  try {
    ips = await resolveIPv4(url.hostname);
  } catch {
    throw new Error("Approved source DNS resolution failed");
  }
  if (ips.length < 1 || ips.length > 16 || !ips.every(isPublicIPv4)) {
    throw new Error("Source DNS resolved to forbidden addresses");
  }
  let response: RawSourceResponse;
  try {
    response = await requestPinned(url, ips[0]);
  } catch {
    throw new Error("Approved source retrieval failed");
  }
  if (response.status !== 200 ||
      response.contentEncoding && response.contentEncoding.toLowerCase() !== "identity" ||
      !response.contentType ||
      !MEDIA_TYPES.has(response.contentType.split(";")[0].trim().toLowerCase()) ||
      !Buffer.isBuffer(response.body) ||
      response.body.length > MAX_BYTES) {
    throw new Error("Source response refused");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  } catch {
    throw new Error("Source text encoding refused");
  }
  // We keep a digest and a bounded ephemeral text body only. No claim is
  // inferred or marked verified; human editorial review remains separate.
  const now = (dependencies.now ?? (() => new Date()))();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid retrieval timestamp");
  return {
    sourceUrl: input,
    fetchedAt: now.toISOString(),
    mediaType: response.contentType.split(";")[0].trim().toLowerCase(),
    sha256: createHash("sha256").update(response.body).digest("hex"),
    text: content,
  };
}
