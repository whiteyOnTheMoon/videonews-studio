import assert from "node:assert/strict";
import test from "node:test";
import { oneShotFeedHttpsRefusalReporter } from "./feed-observer-https-diagnostics.js";

const base: NodeJS.ProcessEnv = {
  VNS_FEED_POLL_STAGE_DIAGNOSTICS: "true",
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_RUNTIME_MODE: "single_pass",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
  VNS_FEED_CANARY_SOURCE_ID: "usgs_news",
  VNS_FEED_CANARY_OPERATOR_ACK: "USGS_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
};

test("live refusal diagnostics require exact USGS one-shot selection and explicit opt-in", () => {
  const denied: NodeJS.ProcessEnv[] = [
    {},
    { ...base, VNS_FEED_POLL_STAGE_DIAGNOSTICS: "false" },
    { ...base, VNS_FEED_RUNTIME_ENABLED: "false" },
    { ...base, VNS_FEED_RUNTIME_MODE: "persistent_worker" },
    { ...base, VNS_FEED_RUNTIME_MODE: "bounded_producer" },
    { ...base, VNS_FEED_SOURCE_BOOTSTRAP: "true" },
    { ...base, VNS_FEED_CANARY_SOURCE_ID: "" },
    { ...base, VNS_FEED_CANARY_SOURCE_ID: "nasa_news" },
    { ...base, VNS_FEED_CANARY_OPERATOR_ACK: "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" },
    { ...base, VNS_FEED_CANARY_OPERATOR_ACK: "" },
  ];
  for (const env of denied) {
    const lines: string[] = [];
    assert.equal(oneShotFeedHttpsRefusalReporter(env, (line) => lines.push(line)), undefined);
    assert.deepEqual(lines, []);
  }
});

test("only configured USGS reason is logged with a bounded known source ID", () => {
  const lines: string[] = [];
  const reporter = oneShotFeedHttpsRefusalReporter(base, (line) => lines.push(line));
  assert.ok(reporter);
  reporter("noaa_news", { kind: "dns_unavailable" });
  reporter("usgs_news", { kind: "dns_unavailable" });
  reporter("usgs_news", { kind: "request_timeout", phase: "before_headers" });
  reporter("usgs_news", {
    kind: "response_stream_refused",
    phase: "response_body",
    bodySizeBand: "under_limit",
    declaredLengthBand: "missing",
  });
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { event: "feed_https_refusal", sourceId: "usgs_news", kind: "dns_unavailable" },
    {
      event: "feed_https_refusal",
      sourceId: "usgs_news",
      kind: "request_timeout",
      phase: "before_headers",
    },
    {
      event: "feed_https_refusal",
      sourceId: "usgs_news",
      kind: "response_stream_refused",
      phase: "response_body",
      bodySizeBand: "under_limit",
      declaredLengthBand: "missing",
    },
  ]);
});

test("HTTP status and phase fields are strictly bounded, no raw upstream data escapes", () => {
  const lines: string[] = [];
  const reporter = oneShotFeedHttpsRefusalReporter(base, (line) => lines.push(line));
  assert.ok(reporter);
  reporter("usgs_news", {
    kind: "http_status_refused",
    httpStatus: 403,
    phase: "before_headers",
  });
  reporter("usgs_news", {
    kind: "https_unavailable",
    httpStatus: 777,
    phase: "PRIVATE_SECRET" as never,
    bodySizeBand: "SECRET_URL" as never,
    declaredLengthBand: "SECRET_HEADERS" as never,
  });
  reporter("usgs_news", {
    kind: "SECRET_UPSTREAM" as never,
    httpStatus: 401,
  });
  reporter("usgs_news", {
    kind: "response_media_type_refused",
    httpStatus: 200,
    phase: "response_body",
    bodySizeBand: "over_limit",
    declaredLengthBand: "invalid",
  });
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    {
      event: "feed_https_refusal",
      sourceId: "usgs_news",
      kind: "http_status_refused",
      httpStatus: 403,
      phase: "before_headers",
    },
    { event: "feed_https_refusal", sourceId: "usgs_news", kind: "https_unavailable" },
    {
      event: "feed_https_refusal",
      sourceId: "usgs_news",
      kind: "response_media_type_refused",
      phase: "response_body",
      bodySizeBand: "over_limit",
      declaredLengthBand: "invalid",
    },
  ]);
  assert.ok(!lines.join("").includes("SECRET"));
});

test("acknowledged NOAA gets separate allowed source and failed telemetry never changes flow", () => {
  const lines: string[] = [];
  const reporter = oneShotFeedHttpsRefusalReporter(
    {
      ...base,
      VNS_FEED_CANARY_SOURCE_ID: "noaa_news",
      VNS_FEED_CANARY_OPERATOR_ACK: "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
    },
    (line) => lines.push(line),
  );
  assert.ok(reporter);
  reporter("usgs_news", { kind: "https_unavailable" });
  reporter("noaa_news", { kind: "response_size_refused" });
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { event: "feed_https_refusal", sourceId: "noaa_news", kind: "response_size_refused" },
  ]);
  const throwing = oneShotFeedHttpsRefusalReporter(base, () => {
    throw new Error("PRIVATE_LOGGER_ERROR");
  });
  assert.ok(throwing);
  assert.doesNotThrow(() => throwing("usgs_news", { kind: "https_unavailable" }));
});
