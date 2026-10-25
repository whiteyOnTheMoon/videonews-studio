import assert from "node:assert/strict";
import test from "node:test";
import { createDormantEditorialWorker } from "./editorial-worker.js";

const config = {
  host: "127.0.0.1",
  port: 6379,
  password: "fixture-not-a-secret",
};

test(
  "editorial worker refuses activation without explicit authorization or handler",
  () => {
  assert.throws(
    () => createDormantEditorialWorker(config, false),
    /explicit authorization/,
  );
  assert.throws(
    () => createDormantEditorialWorker(config, true),
    /research handler/,
  );
  assert.throws(
    () => createDormantEditorialWorker(config, false, async () => ({
      candidatesRecorded: 1,
      needsEditorialReview: true,
    })),
    /explicit authorization/,
  );
  },
);
