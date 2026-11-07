import assert from "node:assert/strict";
import test from "node:test";
import {
  oneShotNasaDecodeRefusalReporter,
  oneShotNasaMetadataRejectionReporter,
} from "./feed-observer-decode-diagnostics.js";
import {
  classifyFeedDecodeRefusal,
  createDormantFeedPoller,
  type FeedDecodeRefusalKind,
} from "./feed-poller.js";
import { NASA_REVIEW_SIZE_ACK } from "./feed-nasa-bounded-response.js";
import { parseReviewedSourceRegistry } from "./source-registry.js";

const ENV = {
  VNS_FEED_POLL_STAGE_DIAGNOSTICS: "true",
  VNS_FEED_NASA_DECODE_DIAGNOSTICS: "true",
  VNS_FEED_NASA_512K_ENABLED: "true",
  VNS_FEED_NASA_512K_OPERATOR_ACK: NASA_REVIEW_SIZE_ACK,
  VNS_FEED_RUNTIME_MODE: "single_pass",
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
  VNS_FEED_CANARY_SOURCE_ID: "nasa_news",
  VNS_FEED_CANARY_OPERATOR_ACK: "NASA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
};

test("feed decoder failure taxonomy emits only exact allowlisted fixed labels", () => {
  const table: ReadonlyArray<readonly [string, FeedDecodeRefusalKind]> = [
    ["Feed response invalid", "response_invalid"],
    ["Feed media type refused", "media_type_refused"],
    ["Feed XML unsafe", "xml_unsafe"],
    ["Feed XML envelope invalid", "xml_envelope_invalid"],
    ["Feed has no supported items", "no_supported_items"],
    ["Feed has no approved metadata", "no_approved_metadata"],
    ["Official feed JSON invalid", "official_json_invalid"],
    ["Official feed shape invalid", "official_shape_invalid"],
  ];
  for (const [message, kind] of table) {
    assert.equal(classifyFeedDecodeRefusal(new Error(message)), kind);
  }
  for (const untrusted of [
    "SECRET_RAW_XML",
    new Error("SECRET_RAW_XML"),
    new Error("Feed XML unsafe SECRET_RAW_XML"),
    { message: "Feed XML unsafe" },
    null,
  ]) {
    assert.equal(classifyFeedDecodeRefusal(untrusted), "other");
  }
});

test("NASA-only decoder reporter requires an independent default-off flag", () => {
  assert.equal(oneShotNasaDecodeRefusalReporter({}), undefined);
  for (const patch of [
    { VNS_FEED_NASA_DECODE_DIAGNOSTICS: "false" },
    { VNS_FEED_POLL_STAGE_DIAGNOSTICS: "false" },
    { VNS_FEED_NASA_512K_ENABLED: "false" },
    { VNS_FEED_NASA_512K_OPERATOR_ACK: "" },
    { VNS_FEED_CANARY_SOURCE_ID: "noaa_news" },
    { VNS_FEED_RUNTIME_MODE: "persistent_worker" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
  ]) {
    assert.equal(oneShotNasaDecodeRefusalReporter({ ...ENV, ...patch }), undefined);
  }
});

test("NASA-only decode reporting never logs raw data or changes the refusal", () => {
  const emitted: string[] = [];
  const callback = oneShotNasaDecodeRefusalReporter(ENV, (line) => emitted.push(line));
  assert.ok(callback);
  callback("nasa_news", "no_approved_metadata");
  callback("noaa_news", "xml_unsafe");
  callback("nasa_news", "SECRET_RAW_XML" as FeedDecodeRefusalKind);
  assert.deepEqual(emitted, [
    '{"event":"feed_decode_refusal","sourceId":"nasa_news","kind":"no_approved_metadata"}',
  ]);
  assert.equal(JSON.stringify(emitted).includes("SECRET_RAW_XML"), false);
  const throwing = oneShotNasaDecodeRefusalReporter(ENV, () => {
    throw new Error("SECRET_OUTPUT_ERROR");
  });
  assert.doesNotThrow(() => throwing?.("nasa_news", "xml_envelope_invalid"));
});

test("poller preserves failure and no-commit semantics with offline fixed-label reporter", async () => {
  const root = "https://www.example.org/";
  const sources = ["science_news", "science_space", "science_weather"].map((id) => ({
    id,
    baseUrl: root + id + "/",
    status: "approved",
    access: "rss",
    intervalMinutes: 60,
    termsUrl: root + "terms/",
    usage: "metadata_only",
    licenseNotes: "Reviewed metadata only.",
    reviewedAt: "2026-11-07",
  }));
  const policy = { enabled: true as const, hosts: ["www.example.org"] };
  const registry = parseReviewedSourceRegistry(JSON.stringify({ version: 1, sources }), policy);
  const emissions: Array<{ source: string; kind: FeedDecodeRefusalKind }> = [];
  let calls = 0;
  const poller = createDormantFeedPoller(
    registry,
    true,
    {
      async claim() {
        return {
          token: "11111111-2222-4333-8444-555555555555",
          validators: { etag: null, lastModified: null },
        };
      },
      async commit() {
        throw new Error("Decoder failure must not write SQL");
      },
    },
    {
      async request() {
        calls++;
        return {
          status: 200,
          mediaType: "application/rss+xml",
          body: "<rss><channel></channel></rss>",
          etag: null,
          lastModified: null,
        };
      },
    },
    undefined,
    undefined,
    "science_news",
    false,
    (source, kind) => {
      emissions.push({ source, kind });
      throw new Error("Output callback failure must not alter poll result");
    },
  );
  assert.deepEqual(await poller.poll(new Date("2026-11-07T12:00:00Z")), [
    { sourceId: "science_news", status: "failed", newItems: 0 },
  ]);
  assert.deepEqual(emissions, [{ source: "science_news", kind: "no_supported_items" }]);
  assert.equal(calls, 1);
});

test("NASA-only metadata rejection counts are opt-in and allowlisted", () => {
  const enabled = { ...ENV, VNS_FEED_NASA_REJECTION_COUNTS: "true" };
  assert.equal(oneShotNasaMetadataRejectionReporter(ENV), undefined);
  for (const patch of [
    { VNS_FEED_NASA_REJECTION_COUNTS: "false" },
    { VNS_FEED_POLL_STAGE_DIAGNOSTICS: "false" },
    { VNS_FEED_NASA_DECODE_DIAGNOSTICS: "false" },
    { VNS_FEED_NASA_512K_ENABLED: "false" },
    { VNS_FEED_CANARY_SOURCE_ID: "noaa_news" },
    { VNS_FEED_RUNTIME_MODE: "persistent_worker" },
  ]) {
    assert.equal(oneShotNasaMetadataRejectionReporter({ ...enabled, ...patch }), undefined);
  }
  const lines: string[] = [];
  const reporter = oneShotNasaMetadataRejectionReporter(enabled, (line) => lines.push(line));
  assert.ok(reporter);
  const counts = {
    scanned: 3,
    outsideApprovedPrefix: 1,
    invalidOrBlockedLink: 1,
    linkFailureReasons: {
      missingOrUnreadable: 0,
      queryString: 1,
      fragment: 0,
      percentEncoded: 0,
      dotSegments: 0,
      invalidPublicUrl: 0,
      nonCanonical: 0,
      blockedOrUnapprovedScope: 0,
      other: 0,
    },
    invalidHeadline: 1,
    invalidPublishedAt: 0,
    duplicate: 0,
    accepted: 0,
  };
  reporter("nasa_news", counts);
  reporter("noaa_news", counts);
  reporter("nasa_news", { ...counts, scanned: 21 });
  reporter("nasa_news", { ...counts, accepted: 1 });
  reporter("nasa_news", { ...counts, linkFailureReasons: { ...counts.linkFailureReasons, queryString: -1 } });
  reporter("nasa_news", { ...counts, rawUrl: "SECRET_URL" } as typeof counts);
  // The final forged object has an untrusted extra field; it may still emit
  // the fixed allowlist but must never serialize the extra value.
  assert.ok(lines.length >= 1);
  assert.equal(JSON.stringify(lines).includes("SECRET_URL"), false);
  const output = JSON.parse(lines[0]!);
  assert.equal(output.event, "feed_rejected_metadata_counts");
  assert.equal(output.sourceId, "nasa_news");
  assert.deepEqual(output.counts, counts);
  const throwing = oneShotNasaMetadataRejectionReporter(enabled, () => {
    throw new Error("SECRET_LOGGER_EXCEPTION");
  });
  assert.doesNotThrow(() => throwing?.("nasa_news", counts));
});

test("count-only NASA metadata rejection is computed on one injected offline response, without SQL write", async () => {
  const host = "https://www.example.org/";
  const sources = ["nasa_news", "science_space", "science_weather"].map((id) => ({
    id,
    baseUrl: host + id + "/",
    status: "approved",
    access: "rss",
    intervalMinutes: 60,
    termsUrl: host + "terms/",
    usage: "metadata_only",
    licenseNotes: "Reviewed metadata only.",
    reviewedAt: "2026-11-07",
  }));
  const registry = parseReviewedSourceRegistry(
    JSON.stringify({ version: 1, sources }),
    { enabled: true, hosts: ["www.example.org"] },
  );
  const bad = "<rss><channel>" +
    "<item><title>Official NASA science report update</title><link>https://www.example.org/outside/report</link></item>" +
    "<item><title>Official NASA mission report update</title><link>https://www.example.org/nasa_news/report?utm_source=secret</link></item>" +
    "<item><title>bad</title><link>https://www.example.org/nasa_news/valid</link></item>" +
    "</channel></rss>";
  let requests = 0;
  let commits = 0;
  const lines: string[] = [];
  const reporter = oneShotNasaMetadataRejectionReporter(
    { ...ENV, VNS_FEED_NASA_REJECTION_COUNTS: "true" },
    (line) => lines.push(line),
  );
  assert.ok(reporter);
  const poller = createDormantFeedPoller(
    registry,
    true,
    {
      async claim() {
        return {
          token: "11111111-2222-4333-8444-555555555555",
          validators: { etag: null, lastModified: null },
        };
      },
      async commit() {
        commits++;
        return 0;
      },
    },
    {
      async request() {
        requests++;
        return {
          status: 200,
          mediaType: "application/rss+xml",
          body: bad,
          etag: null,
          lastModified: null,
        };
      },
    },
    undefined,
    undefined,
    "nasa_news",
    false,
    undefined,
    reporter,
  );
  assert.deepEqual(await poller.poll(new Date("2026-11-07T12:00:00Z")), [
    { sourceId: "nasa_news", status: "failed", newItems: 0 },
  ]);
  assert.equal(requests, 1);
  assert.equal(commits, 0);
  assert.equal(lines.length, 1);
  const observed = JSON.parse(lines[0]!);
  assert.equal(observed.counts.scanned, 3);
  assert.equal(observed.counts.outsideApprovedPrefix, 1);
  assert.equal(observed.counts.linkFailureReasons.queryString, 1);
  assert.equal(observed.counts.invalidHeadline, 1);
  assert.equal(observed.counts.accepted, 0);
  assert.equal(lines[0]?.includes("utm_source"), false);
  assert.equal(lines[0]?.includes("report"), false);
});
