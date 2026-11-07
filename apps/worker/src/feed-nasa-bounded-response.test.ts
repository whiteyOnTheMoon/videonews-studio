import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FEED_MAX_BYTES,
  NASA_REVIEW_MAX_BYTES,
  NASA_REVIEW_FEED_URL,
  NASA_REVIEW_SIZE_ACK,
  feedResponseMaxBytes,
  readNasaBoundedResponseGate,
} from "./feed-nasa-bounded-response.js";
import { decodeApprovedFeed } from "./feed-poller.js";
import { createPinnedFeedHttpsTransport } from "./feed-https-transport.js";
import { parseReviewedSourceRegistry } from "./source-registry.js";

const NASA = {
  id: "nasa_news",
  baseUrl: "https://www.nasa.gov/news/",
  feedUrl: NASA_REVIEW_FEED_URL,
  status: "approved",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://www.nasa.gov/terms/",
  usage: "metadata_only",
  licenseNotes: "Offline synthetic approved metadata only.",
  reviewedAt: "2026-11-06",
} as const;
const POLICY = { enabled: true as const, hosts: ["www.nasa.gov"] };
const REGISTRY = parseReviewedSourceRegistry(
  JSON.stringify({ version: 1, sources: [NASA] }),
  POLICY,
);
const SOURCE = REGISTRY[0]!;

const CANARY = {
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_RUNTIME_MODE: "single_pass",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
  VNS_FEED_CANARY_SOURCE_ID: "nasa_news",
  VNS_FEED_CANARY_OPERATOR_ACK: "NASA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
  VNS_FEED_NASA_512K_ENABLED: "true",
  VNS_FEED_NASA_512K_OPERATOR_ACK: NASA_REVIEW_SIZE_ACK,
};

const compactRss =
  '<rss version="2.0"><channel><item>' +
  "<title>Independent NASA metadata bulletin number one</title>" +
  "<link>https://www.nasa.gov/news/research-update-one</link>" +
  "<pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate>" +
  "</item></channel></rss>";
const largeRss = compactRss.replace("</channel>", " ".repeat(180000) + "</channel>");

test("NASA 512-KiB review remains dormant without both independent flags", () => {
  assert.equal(readNasaBoundedResponseGate({}), false);
  assert.equal(readNasaBoundedResponseGate({ VNS_FEED_NASA_512K_ENABLED: "false" }), false);
  for (const patch of [
    { VNS_FEED_NASA_512K_ENABLED: "false" },
    { VNS_FEED_NASA_512K_OPERATOR_ACK: "" },
    { VNS_FEED_CANARY_SOURCE_ID: "noaa_news" },
    { VNS_FEED_CANARY_OPERATOR_ACK: "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" },
    { VNS_FEED_RUNTIME_MODE: "persistent_worker" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
    { VNS_FEED_RUNTIME_ENABLED: "false" },
    { VNS_FEED_NASA_512K_ENABLED: "yes" },
  ]) {
    assert.throws(
      () => readNasaBoundedResponseGate({ ...CANARY, ...patch }),
      /not authorized|canary gate refused/,
    );
  }
  assert.equal(readNasaBoundedResponseGate(CANARY), true);
});

test("extended budget is limited to the exact signed NASA RSS URL and metadata usage", () => {
  assert.equal(feedResponseMaxBytes(SOURCE, false), DEFAULT_FEED_MAX_BYTES);
  assert.equal(feedResponseMaxBytes(SOURCE, true), NASA_REVIEW_MAX_BYTES);
  for (const changed of [
    { ...SOURCE, id: "noaa_news" },
    { ...SOURCE, feedUrl: "https://www.nasa.gov/other/feed/" },
    { ...SOURCE, feedUrl: undefined },
    { ...SOURCE, status: "blocked" as const },
    { ...SOURCE, access: "official_api" as const },
    { ...SOURCE, usage: "full_text" as never },
  ]) {
    assert.throws(() => feedResponseMaxBytes(changed, true), /scope refused/);
  }
});

test("HTTPS and XML decoder agree on default and exact NASA-only 512-KiB bound offline", async () => {
  assert.ok(Buffer.byteLength(largeRss) > DEFAULT_FEED_MAX_BYTES);
  assert.ok(Buffer.byteLength(largeRss) < NASA_REVIEW_MAX_BYTES);
  const deps = {
    async resolveIPv4() {
      return ["1.1.1.1"];
    },
    async requestPinned() {
      return {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
        body: Buffer.from(largeRss),
      };
    },
  };
  const defaultTransport = createPinnedFeedHttpsTransport(REGISTRY, POLICY, deps);
  await assert.rejects(
    defaultTransport.request(SOURCE, { etag: null, lastModified: null }),
    /response bytes refused/,
  );
  const elevated = createPinnedFeedHttpsTransport(REGISTRY, POLICY, deps, true);
  const result = await elevated.request(SOURCE, { etag: null, lastModified: null });
  assert.equal(result.status, 200);
  assert.throws(() => decodeApprovedFeed(SOURCE, REGISTRY, result), /response invalid/);
  const parsed = decodeApprovedFeed(SOURCE, REGISTRY, result, true);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.sourceId, "nasa_news");
  assert.equal(parsed[0]?.headline, "Independent NASA metadata bulletin number one");
});

test("512 KiB plus one byte remains refused and never results in decoded metadata", async () => {
  const body = Buffer.alloc(NASA_REVIEW_MAX_BYTES + 1, 32);
  let attempts = 0;
  const oversized = createPinnedFeedHttpsTransport(REGISTRY, POLICY, {
    async resolveIPv4() {
      return ["1.1.1.1"];
    },
    async requestPinned() {
      attempts++;
      return {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
        body,
      };
    },
  }, true);
  await assert.rejects(
    oversized.request(SOURCE, { etag: null, lastModified: null }),
    /response bytes refused/,
  );
  assert.equal(attempts, 1);
  const changed = { ...SOURCE, feedUrl: "https://www.nasa.gov/new-feed/" };
  const blocked = createPinnedFeedHttpsTransport(REGISTRY, POLICY, {
    async resolveIPv4() {
      throw new Error("Must not resolve unapproved NASA URL");
    },
    async requestPinned() {
      throw new Error("Must not fetch unapproved NASA URL");
    },
  }, true);
  await assert.rejects(blocked.request(changed, { etag: null, lastModified: null }));
});
