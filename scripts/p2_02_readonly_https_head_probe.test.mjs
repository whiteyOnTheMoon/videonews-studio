import assert from "node:assert/strict";
import test from "node:test";
import {
  dnsVerdict,
  runReadOnlyProbe,
  safeErrorCode,
  safeErrorFamily,
  validatedProbeSources,
} from "./p2_02_readonly_https_head_probe.mjs";

const INPUT = [
  { id: "nasa_news", url: "https://www.nasa.gov/news-release/feed/" },
  { id: "noaa_news", url: "https://www.noaa.gov/rss.xml" },
  { id: "usgs_news", url: "https://www.usgs.gov/news/national-news-release/feed" },
];
const validIp = (ip) => ip === "1.1.1.1" || ip === "8.8.8.8";

test("exact current source IDs, expected hostnames, no URL exploits", () => {
  const approved = validatedProbeSources(INPUT);
  assert.deepEqual(
    approved.map((source) => source.id),
    ["nasa_news", "noaa_news", "usgs_news"],
  );
  for (const mutation of [
    INPUT.slice(0, 2),
    [...INPUT, INPUT[0]],
    [INPUT[0], INPUT[0], INPUT[2]],
    [{ ...INPUT[0], url: "https://127.0.0.1/feed/" }, ...INPUT.slice(1)],
    [{ ...INPUT[0], url: "http://www.nasa.gov/feed/" }, ...INPUT.slice(1)],
    [{ ...INPUT[0], url: "https://www.nasa.gov:443/feed/" }, ...INPUT.slice(1)],
    [{ ...INPUT[0], url: "https://www.nasa.gov/feed/?a=1" }, ...INPUT.slice(1)],
    [{ ...INPUT[0], url: "https://www.nasa.gov/%2e%2e/" }, ...INPUT.slice(1)],
    [{ ...INPUT[0], extra: true }, ...INPUT.slice(1)],
  ]) {
    assert.throws(() => validatedProbeSources(mutation), /refused/);
  }
});

test("DNS rejects all unsafe or oversized answer sets without fallback", () => {
  assert.deepEqual(dnsVerdict(["1.1.1.1"], validIp), {
    status: "approved_ipv4_set",
    count: 1,
    forbiddenCount: 0,
  });
  assert.equal(dnsVerdict([], validIp).status, "empty_dns_response");
  assert.equal(dnsVerdict(["1.1.1.1", "127.0.0.1"], validIp).status, "non_public_ipv4_in_answers");
  assert.equal(
    dnsVerdict(
      Array.from({ length: 17 }, () => "8.8.8.8"),
      validIp,
    ).status,
    "too_many_ipv4_answers",
  );
});

test("HTTP probe reports only bounded headers, never URLs or response content", async () => {
  const sources = validatedProbeSources(INPUT);
  const requested = [];
  const reports = await runReadOnlyProbe(sources, {
    isPublicIPv4: validIp,
    async resolveIPv4() {
      return ["1.1.1.1"];
    },
    async requestHead(url, ip) {
      requested.push([url.hostname, ip]);
      return { status: 301, mediaType: "text/html", compressed: false };
    },
  });
  assert.equal(requested.length, 3);
  assert.ok(reports.every((item) => item.stage === "head_completed"));
  assert.ok(reports.every((item) => item.redirect && item.mediaType === "other"));
  assert.equal(JSON.stringify(reports).includes("https://"), false);
  assert.equal(JSON.stringify(reports).includes("1.1.1.1"), false);
});

test("unapproved DNS cannot trigger HTTPS, raw errors never reach operator report", async () => {
  const sources = validatedProbeSources(INPUT);
  const report = await runReadOnlyProbe(sources, {
    isPublicIPv4: validIp,
    async resolveIPv4(hostname) {
      if (hostname === "www.nasa.gov") return ["1.1.1.1", "127.0.0.1"];
      return ["1.1.1.1"];
    },
    async requestHead() {
      throw Object.assign(new Error("TOP_SECRET_TLS_URL"), { code: "ETIMEDOUT" });
    },
  });
  assert.deepEqual(
    report.map((item) => item.stage),
    ["dns_rejected", "https_or_tls_unavailable", "https_or_tls_unavailable"],
  );
  assert.equal(report[1].errorCode, "ETIMEDOUT");
  assert.equal(JSON.stringify(report).includes("TOP_SECRET"), false);
});

test("unknown errors have only fixed categories and handshake phases", async () => {
  const sources = validatedProbeSources(INPUT);
  const report = await runReadOnlyProbe(sources, {
    isPublicIPv4: validIp,
    async resolveIPv4() {
      return ["1.1.1.1"];
    },
    async requestHead() {
      throw {
        underlying: { code: "ERR_SSL_PRIVATE_URL_in_error", message: "SECRET_FEED_URL" },
        connectionPhase: "tcp_connected",
      };
    },
  });
  assert.equal(report.length, 3);
  assert.ok(report.every((item) => item.errorCode === "OTHER"));
  assert.ok(report.every((item) => item.errorFamily === "unclassified"));
  assert.ok(report.every((item) => item.connectionPhase === "tcp_connected"));
  assert.ok(!JSON.stringify(report).includes("SECRET_FEED_URL"));
  assert.ok(!JSON.stringify(report).includes("PRIVATE_URL"));
});

test("only exact recognized TLS/network codes may leave the process", () => {
  assert.equal(
    safeErrorCode({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    "ERR_TLS_CERT_ALTNAME_INVALID",
  );
  assert.equal(safeErrorCode({ code: "SECRET_TOKEN_123" }), "OTHER");
  assert.equal(safeErrorCode(new Error("SECRET")), "OTHER");
  assert.equal(safeErrorCode({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }), "UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
  assert.equal(safeErrorFamily({ code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR" }), "openssl_tls");
  assert.equal(safeErrorFamily({ code: "ERR_INVALID_THIS" }), "node_runtime");
  assert.equal(safeErrorFamily({ code: "SECRET_PRIVATE_KEY" }), "unclassified");
});
