import assert from "node:assert/strict";
import test from "node:test";
import {
  STUDIO_MANUAL_NOAA_ACK,
  readStudioManualNoaaSelection,
} from "./feed-studio-manual-noaa-selection.js";

const approved: NodeJS.ProcessEnv = {
  VNS_FEED_STUDIO_NOAA_ONLY_ENABLED: "true",
  VNS_FEED_STUDIO_NOAA_ONLY_OPERATOR_ACK: STUDIO_MANUAL_NOAA_ACK,
  VNS_FEED_STUDIO_SOURCE_ID: "noaa_news",
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_RUNTIME_MODE: "persistent_worker",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
  VNS_FEED_SEPARATE_WORKER_ENABLED: "true",
  VNS_FEED_SEPARATE_WORKER_OPERATOR_ACK: "true",
};

test("manual NOAA is off by default and cannot enable sources implicitly", () => {
  assert.equal(readStudioManualNoaaSelection({}, "persistent_worker"), null);
  assert.equal(
    readStudioManualNoaaSelection(
      { VNS_FEED_STUDIO_NOAA_ONLY_ENABLED: "false" },
      "persistent_worker",
    ),
    null,
  );
  assert.equal(readStudioManualNoaaSelection(approved, "persistent_worker"), "noaa_news");
});

test("manual NOAA requires distinct complete consumer-only runtime approval", () => {
  for (const key of Object.keys(approved)) {
    for (const change of ["", "false"]) {
      assert.throws(
        () => readStudioManualNoaaSelection({ ...approved, [key]: change }, "persistent_worker"),
        /source gate refused/,
        key,
      );
    }
  }
  for (const value of ["nasa_news", "usgs_news", "unknown", "noaa_news,usgs_news"]) {
    assert.throws(
      () =>
        readStudioManualNoaaSelection(
          { ...approved, VNS_FEED_STUDIO_SOURCE_ID: value },
          "persistent_worker",
        ),
      /source gate refused/,
    );
  }
  for (const mode of ["single_pass", "bounded_producer", "continuous_producer"]) {
    assert.throws(() => readStudioManualNoaaSelection(approved, mode), /source gate refused/);
  }
  for (const extra of [
    { VNS_FEED_CANARY_SOURCE_ID: "noaa_news" },
    { VNS_FEED_CANARY_OPERATOR_ACK: "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" },
    { VNS_FEED_STUDIO_NOAA_ONLY_OPERATOR_ACK: "true" },
  ]) {
    assert.throws(
      () => readStudioManualNoaaSelection({ ...approved, ...extra }, "persistent_worker"),
      /source gate refused/,
    );
  }
});
