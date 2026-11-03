import assert from "node:assert/strict";
import test from "node:test";
import { decodeApprovedFeed } from "../apps/worker/dist/feed-poller.js";
import { createPinnedFeedHttpsTransport } from "../apps/worker/dist/feed-https-transport.js";
import {
  approvedSourceForUrl,
  parseReviewedSourceRegistry,
} from "../apps/worker/dist/source-registry.js";
import {
  runReadOnlyRssGetProbe,
  validatedReadOnlyGetRegistry,
} from "./p2_02_readonly_rss_get_probe.mjs";

const HOSTS = {
  nasa_news: "www.nasa.gov",
  noaa_news: "www.noaa.gov",
  usgs_news: "www.usgs.gov",
};
const makeSource = (id, host) => ({
  id,
  baseUrl: `https://${host}/news/`,
  feedUrl: `https://${host}/rss.xml`,
  status: "approved",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: `https://${host}/terms/`,
  usage: "metadata_only",
  licenseNotes: "Only approved news metadata may be inspected.",
  reviewedAt: "2026-11-01",
});
const input = () => ({
  version: 1,
  sources: Object.entries(HOSTS).map(([id, host]) => makeSource(id, host)),
});
const validated = (raw = input()) =>
  validatedReadOnlyGetRegistry(raw, parseReviewedSourceRegistry, approvedSourceForUrl);

function transportFor(plan, reply) {
  const calls = [];
  const transport = createPinnedFeedHttpsTransport(plan.registry, plan.policy, {
    resolveIPv4: async (host) => {
      assert.ok(Object.values(HOSTS).includes(host));
      return ["1.1.1.1"];
    },
    requestPinned: async (url, ip) => {
      calls.push({ hostname: url.hostname, ip, pathname: url.pathname });
      return reply(url);
    },
  });
  return { transport, calls };
}

function rss(url) {
  return (
    '<rss version="2.0"><channel><item>' +
    "<title>Example validated science announcement</title>" +
    `<link>https://${url.hostname}/news/approved-item</link>` +
    "<pubDate>Tue, 03 Nov 2026 12:00:00 GMT</pubDate>" +
    "</item></channel></rss>"
  );
}
const ok = (url) => ({
  status: 200,
  headers: { "content-type": "application/rss+xml; charset=utf-8" },
  body: Buffer.from(rss(url)),
});

test("only the three currently approved source IDs, host scopes and RSS usage are admitted", () => {
  const plan = validated();
  assert.deepEqual(
    plan.approved.map((source) => source.id),
    ["nasa_news", "noaa_news", "usgs_news"],
  );
  const original = input();
  for (const invalid of [
    { ...original, extra: true },
    { version: 2, sources: original.sources },
    { version: 1, sources: original.sources.slice(0, 2) },
    {
      version: 1,
      sources: [...original.sources, makeSource("extra_news", "www.nasa.gov")],
    },
    {
      version: 1,
      sources: original.sources.map((source) =>
        source.id === "nasa_news" ? { ...source, status: "pending" } : source,
      ),
    },
    {
      version: 1,
      sources: original.sources.map((source) =>
        source.id === "nasa_news" ? { ...source, usage: "reviewed_excerpt" } : source,
      ),
    },
    {
      version: 1,
      sources: original.sources.map((source) =>
        source.id === "nasa_news" ? { ...source, feedUrl: "https://www.usgs.gov/rss.xml" } : source,
      ),
    },
    {
      version: 1,
      sources: original.sources.map((source) =>
        source.id === "nasa_news"
          ? { ...source, feedUrl: "https://www.nasa.gov/rss.xml?secret=1" }
          : source,
      ),
    },
  ]) {
    assert.throws(() => validated(invalid), /refused/);
  }
});

test("read-only GET uses the actual pinned worker transport and decoder, without persistence", async () => {
  const plan = validated();
  const { transport, calls } = transportFor(plan, ok);
  const report = await runReadOnlyRssGetProbe(plan, transport, decodeApprovedFeed);
  assert.deepEqual(report, [
    {
      sourceId: "nasa_news",
      stage: "metadata_accepted",
      httpStatus: 200,
      mediaType: "application/rss+xml",
      parser: "project_decoder_accepted",
      approvedArticleUrls: 1,
    },
    {
      sourceId: "noaa_news",
      stage: "metadata_accepted",
      httpStatus: 200,
      mediaType: "application/rss+xml",
      parser: "project_decoder_accepted",
      approvedArticleUrls: 1,
    },
    {
      sourceId: "usgs_news",
      stage: "metadata_accepted",
      httpStatus: 200,
      mediaType: "application/rss+xml",
      parser: "project_decoder_accepted",
      approvedArticleUrls: 1,
    },
  ]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((item) => item.ip === "1.1.1.1" && item.pathname === "/rss.xml"));
  assert.equal(JSON.stringify(report).includes("https://"), false);
  assert.equal(JSON.stringify(report).includes("approved-item"), false);
});

test("redirects, forbidden MIME, compression and oversized bodies fail without followups", async () => {
  const cases = [
    (url) => ({ ...ok(url), status: 301, headers: { location: "https://secret.invalid/" } }),
    (url) => ({ ...ok(url), headers: { "content-type": "text/html" } }),
    (url) => ({
      ...ok(url),
      headers: { "content-type": "application/rss+xml", "content-encoding": "gzip" },
    }),
    () => ({
      status: 200,
      headers: { "content-type": "application/rss+xml" },
      body: Buffer.alloc(131073),
    }),
  ];
  for (const reply of cases) {
    const plan = validated();
    const { transport, calls } = transportFor(plan, reply);
    const report = await runReadOnlyRssGetProbe(plan, transport, decodeApprovedFeed);
    assert.equal(calls.length, 3);
    assert.ok(report.every((result) => result.stage === "https_or_http_refused"));
    assert.equal(JSON.stringify(report).includes("secret.invalid"), false);
  }
});

test("XML and article URL scope failures are classified without leaking feed content", async () => {
  const plan = validated();
  const invalidBodies = [
    ["<html>TOP_SECRET</html>", "xml_envelope_invalid"],
    ["<!DOCTYPE rss><rss><channel><item></item></channel></rss>", "unsafe_xml"],
    [
      "<rss><channel><item><title>Example science announcement</title>" +
        "<link>https://bad.example.org/news/unapproved</link></item></channel></rss>",
      "no_approved_metadata",
    ],
  ];
  for (const [body, expectedReason] of invalidBodies) {
    const { transport } = transportFor(plan, () => ({
      status: 200,
      headers: { "content-type": "application/rss+xml" },
      body: Buffer.from(body),
    }));
    const result = await runReadOnlyRssGetProbe(plan, transport, decodeApprovedFeed);
    assert.equal(result.length, 3);
    assert.ok(result.every((entry) => entry.stage === "metadata_refused"));
    assert.ok(result.every((entry) => entry.reason === expectedReason));
    assert.equal(JSON.stringify(result).includes("TOP_SECRET"), false);
    assert.equal(JSON.stringify(result).includes("bad.example.org"), false);
  }
});

test("unexpected private exceptions are suppressed, never mirrored to report", async () => {
  const plan = validated();
  const report = await runReadOnlyRssGetProbe(
    plan,
    {
      async request() {
        throw new Error("SECRET_FROM_REMOTE");
      },
    },
    decodeApprovedFeed,
  );
  assert.equal(report.length, 3);
  assert.ok(report.every((entry) => entry.stage === "https_or_http_refused"));
  assert.ok(!JSON.stringify(report).includes("SECRET"));
});

test("transport refusal categories and bounded HTTP status are passed through safely", async () => {
  const plan = validated();
  const failures = new Map();
  const transport = createPinnedFeedHttpsTransport(plan.registry, plan.policy, {
    resolveIPv4: async () => ["1.1.1.1"],
    requestPinned: async () => ({
      status: 301,
      headers: { location: "https://PRIVATE_SECRET.example/" },
      body: Buffer.alloc(0),
    }),
    onRefusal(sourceId, refusal) {
      failures.set(sourceId, refusal);
    },
  });
  const report = await runReadOnlyRssGetProbe(plan, transport, decodeApprovedFeed, failures);
  assert.deepEqual(
    report.map((result) => [result.stage, result.refusal, result.httpStatus]),
    [
      ["https_or_http_refused", "http_status_refused", 301],
      ["https_or_http_refused", "http_status_refused", 301],
      ["https_or_http_refused", "http_status_refused", 301],
    ],
  );
  assert.ok(!JSON.stringify(report).includes("PRIVATE_SECRET"));
});

test("forged diagnostic fields are reduced to a fixed code without arbitrary text", async () => {
  const plan = validated();
  const failures = new Map(
    plan.approved.map((src) => [
      src.id,
      { kind: "SECRET_FROM_HTTP", httpStatus: 999, location: "PRIVATE_URL" },
    ]),
  );
  const report = await runReadOnlyRssGetProbe(
    plan,
    { async request() { throw new Error("private URL, token and headers"); } },
    decodeApprovedFeed,
    failures,
  );
  assert.ok(report.every((result) => result.refusal === "unclassified"));
  assert.ok(report.every((result) => !("httpStatus" in result)));
  assert.ok(!JSON.stringify(report).includes("PRIVATE"));
});
