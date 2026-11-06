import assert from "node:assert/strict";
import test from "node:test";
import {
  P2_NASA_CANARY_ACK,
  P2_NOAA_CANARY_ACK,
  P2_USGS_CANARY_ACK,
  readSingleSourceCanarySelection,
} from "./feed-canary-source-selection.js";

const base = {
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_RUNTIME_MODE: "single_pass",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
};
const nasa = {
  ...base,
  VNS_FEED_CANARY_SOURCE_ID: "nasa_news",
  VNS_FEED_CANARY_OPERATOR_ACK: P2_NASA_CANARY_ACK,
};
const noaa = {
  ...base,
  VNS_FEED_CANARY_SOURCE_ID: "noaa_news",
  VNS_FEED_CANARY_OPERATOR_ACK: P2_NOAA_CANARY_ACK,
};
const usgs = {
  ...base,
  VNS_FEED_CANARY_SOURCE_ID: "usgs_news",
  VNS_FEED_CANARY_OPERATOR_ACK: P2_USGS_CANARY_ACK,
};

test("independent exact NASA, NOAA and USGS one-shot acknowledgements, default no selector", () => {
  assert.equal(readSingleSourceCanarySelection(nasa, "single_pass"), "nasa_news");
  assert.equal(readSingleSourceCanarySelection(noaa, "single_pass"), "noaa_news");
  assert.equal(readSingleSourceCanarySelection(usgs, "single_pass"), "usgs_news");
  assert.equal(readSingleSourceCanarySelection({}, "single_pass"), null);
  assert.equal(
    readSingleSourceCanarySelection(
      { VNS_FEED_CANARY_SOURCE_ID: "", VNS_FEED_CANARY_OPERATOR_ACK: "" },
      "single_pass",
    ),
    null,
  );
});

test("all three source selectors reject cross-acknowledgements and non-single-pass", () => {
  for (const valid of [nasa, noaa, usgs]) {
    for (const [key, invalid] of [
      ["VNS_FEED_RUNTIME_ENABLED", "false"],
      ["VNS_FEED_RUNTIME_MODE", "persistent_worker"],
      ["VNS_FEED_SOURCE_BOOTSTRAP", "true"],
      ["VNS_FEED_CANARY_SOURCE_ID", valid.VNS_FEED_CANARY_SOURCE_ID === "nasa_news" ? "noaa_news" : "nasa_news"],
      ["VNS_FEED_CANARY_SOURCE_ID", "unknown_source"],
      ["VNS_FEED_CANARY_SOURCE_ID", ""],
      ["VNS_FEED_CANARY_OPERATOR_ACK", "true"],
      ["VNS_FEED_CANARY_OPERATOR_ACK", ""],
      ...[P2_NASA_CANARY_ACK, P2_NOAA_CANARY_ACK, P2_USGS_CANARY_ACK]
        .filter((ack) => ack !== valid.VNS_FEED_CANARY_OPERATOR_ACK)
        .map((ack) => ["VNS_FEED_CANARY_OPERATOR_ACK", ack] as const),
    ] as const) {
      assert.throws(
        () => readSingleSourceCanarySelection({ ...valid, [key]: invalid }, "single_pass"),
        /canary gate refused/,
      );
    }
    for (const mode of ["persistent_worker", "bounded_producer", "continuous_producer"]) {
      assert.throws(() => readSingleSourceCanarySelection(valid, mode), /canary gate refused/);
    }
  }
});
