import assert from "node:assert/strict";
import test from "node:test";
import {
  P2_NOAA_CANARY_ACK,
  readSingleSourceCanarySelection,
} from "./feed-canary-source-selection.js";

const safe = {
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_RUNTIME_MODE: "single_pass",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
  VNS_FEED_CANARY_SOURCE_ID: "noaa_news",
  VNS_FEED_CANARY_OPERATOR_ACK: P2_NOAA_CANARY_ACK,
};

test("only exact NOAA source and explicit one-shot operator authorization may select canary", () => {
  assert.equal(readSingleSourceCanarySelection(safe, "single_pass"), "noaa_news");
  assert.equal(readSingleSourceCanarySelection({}, "single_pass"), null);
  assert.equal(
    readSingleSourceCanarySelection(
      { VNS_FEED_CANARY_SOURCE_ID: "", VNS_FEED_CANARY_OPERATOR_ACK: "" },
      "single_pass",
    ),
    null,
  );
  for (const [key, invalid] of [
    ["VNS_FEED_RUNTIME_ENABLED", "false"],
    ["VNS_FEED_RUNTIME_MODE", "persistent_worker"],
    ["VNS_FEED_SOURCE_BOOTSTRAP", "true"],
    ["VNS_FEED_CANARY_SOURCE_ID", "nasa_news"],
    ["VNS_FEED_CANARY_SOURCE_ID", "usgs_news"],
    ["VNS_FEED_CANARY_SOURCE_ID", "unknown_source"],
    ["VNS_FEED_CANARY_SOURCE_ID", ""],
    ["VNS_FEED_CANARY_OPERATOR_ACK", "true"],
    ["VNS_FEED_CANARY_OPERATOR_ACK", ""],
  ] as const) {
    assert.throws(
      () => readSingleSourceCanarySelection({ ...safe, [key]: invalid }, "single_pass"),
      /canary gate refused/,
    );
  }
  assert.throws(
    () => readSingleSourceCanarySelection(safe, "persistent_worker"),
    /canary gate refused/,
  );
  assert.throws(
    () => readSingleSourceCanarySelection(safe, "bounded_producer"),
    /canary gate refused/,
  );
});
