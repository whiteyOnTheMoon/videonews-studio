import { lookup } from "node:dns/promises";
import https from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const APPROVED = Object.freeze({
  nasa_news: "www.nasa.gov",
  noaa_news: "www.noaa.gov",
  usgs_news: "www.usgs.gov",
});
const KNOWN_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ABORT_ERR",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_IP_ADDRESS",
  "ERR_INVALID_PROTOCOL",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERTIFICATE_VERIFY_FAILED",
]);
const ALLOWED_TYPES = new Set(["application/rss+xml", "application/xml", "text/xml"]);
const REFUSED = "Read-only feed HEAD probe refused";

/** Not an HTTP authorization or source-enrollment function. */
export function validatedProbeSources(input) {
  if (!Array.isArray(input) || input.length !== 3) throw new Error(REFUSED);
  const seen = new Set();
  const sources = [];
  for (const entry of input) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "id,url" ||
      typeof entry.id !== "string" ||
      typeof entry.url !== "string" ||
      !Object.hasOwn(APPROVED, entry.id) ||
      seen.has(entry.id)
    ) {
      throw new Error(REFUSED);
    }
    let url;
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error(REFUSED);
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== APPROVED[entry.id] ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.toString() !== entry.url ||
      !url.pathname.startsWith("/") ||
      url.pathname.includes("%") ||
      entry.url.length > 512
    ) {
      throw new Error(REFUSED);
    }
    seen.add(entry.id);
    sources.push({ id: entry.id, url });
  }
  return sources.sort((left, right) => left.id.localeCompare(right.id, "en"));
}

export function dnsVerdict(addresses, isPublicIPv4) {
  if (!Array.isArray(addresses) || addresses.some((value) => typeof value !== "string")) {
    return { status: "invalid_dns_response", count: 0, forbiddenCount: 0 };
  }
  const count = addresses.length;
  const forbiddenCount = addresses.filter((ip) => !isPublicIPv4(ip)).length;
  const status =
    count === 0
      ? "empty_dns_response"
      : count > 16
        ? "too_many_ipv4_answers"
        : forbiddenCount > 0
          ? "non_public_ipv4_in_answers"
          : "approved_ipv4_set";
  return { status, count, forbiddenCount };
}

export function safeErrorCode(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && KNOWN_ERROR_CODES.has(code) ? code : "OTHER";
}

/** Closed classifications when a new Node/OpenSSL error is not yet allowlisted. */
export function safeErrorFamily(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  if (typeof code !== "string") return "no_error_code";
  if (/^ERR_SSL_[A-Z0-9_]{2,64}$/.test(code)) return "openssl_tls";
  if (/^ERR_TLS_[A-Z0-9_]{2,64}$/.test(code)) return "node_tls";
  if (/^ERR_[A-Z0-9_]{2,64}$/.test(code)) return "node_runtime";
  if (/^(?:CERT_|UNABLE_TO_|DEPTH_ZERO_)[A-Z0-9_]{2,64}$/.test(code)) {
    return "certificate";
  }
  if (/^E[A-Z0-9_]{2,64}$/.test(code)) return "system_or_socket";
  return "unclassified";
}

function safeConnectionPhase(error) {
  return error &&
    typeof error === "object" &&
    ["tcp_not_established", "tcp_connected", "tls_authenticated"].includes(error.connectionPhase)
    ? error.connectionPhase
    : "not_observed";
}

export async function runReadOnlyProbe(sources, ports) {
  const report = [];
  for (const source of sources) {
    let ips;
    try {
      ips = await ports.resolveIPv4(source.url.hostname);
    } catch (error) {
      report.push({
        sourceId: source.id,
        stage: "dns_unavailable",
        errorCode: safeErrorCode(error),
      });
      continue;
    }
    const dns = dnsVerdict(ips, ports.isPublicIPv4);
    if (dns.status !== "approved_ipv4_set") {
      report.push({ sourceId: source.id, stage: "dns_rejected", dns });
      continue;
    }
    try {
      // Do not fall back to unreviewed IPs, follow redirects or request feed bodies.
      const response = await ports.requestHead(source.url, ips[0]);
      const type = response.mediaType;
      report.push({
        sourceId: source.id,
        stage: "head_completed",
        dns,
        status: Number.isInteger(response.status) ? response.status : null,
        mediaType: ALLOWED_TYPES.has(type) ? type : type ? "other" : "missing",
        compressed: response.compressed === true,
        redirect: response.status >= 300 && response.status < 400,
      });
    } catch (error) {
      report.push({
        sourceId: source.id,
        stage: "https_or_tls_unavailable",
        dns,
        errorCode: safeErrorCode(error?.underlying ?? error),
        errorFamily: safeErrorFamily(error?.underlying ?? error),
        connectionPhase: safeConnectionPhase(error),
      });
    }
  }
  return report;
}

function requestHead(url, address, createPinnedHttpsOptions) {
  return new Promise((resolve, reject) => {
    const options = createPinnedHttpsOptions(url, address);
    let connectionPhase = "tcp_not_established";
    const request = https.request({ ...options, method: "HEAD" }, (response) => {
      const header = response.headers["content-type"];
      const encoding = response.headers["content-encoding"];
      response.resume();
      resolve({
        status: response.statusCode ?? 0,
        mediaType: typeof header === "string" ? header.split(";")[0]?.trim().toLowerCase() : "",
        compressed: typeof encoding === "string" && encoding.toLowerCase() !== "identity",
      });
    });
    request.on("socket", (socket) => {
      socket.once("connect", () => {
        connectionPhase = "tcp_connected";
      });
      socket.once("secureConnect", () => {
        connectionPhase = "tls_authenticated";
      });
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error(), { code: "ETIMEDOUT" })));
    request.on("error", (underlying) => reject({ underlying, connectionPhase }));
    request.end();
  });
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--head-only") {
    throw new Error(REFUSED);
  }
  let contents = "";
  for await (const chunk of process.stdin) {
    contents += chunk.toString("utf8");
    if (Buffer.byteLength(contents, "utf8") > 4096) throw new Error(REFUSED);
  }
  const sources = validatedProbeSources(JSON.parse(contents));
  const { createPinnedHttpsOptions, isPublicIPv4 } = await import(
    pathToFileURL(resolve(process.cwd(), "apps/worker/dist/source-fetch.js")).href
  );
  const reports = await runReadOnlyProbe(sources, {
    isPublicIPv4,
    resolveIPv4: async (hostname) =>
      (await lookup(hostname, { all: true, family: 4 })).map((entry) => entry.address),
    requestHead: (url, ip) => requestHead(url, ip, createPinnedHttpsOptions),
  });
  for (const item of reports) console.log(JSON.stringify(item));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(REFUSED);
    process.exitCode = 1;
  });
}
