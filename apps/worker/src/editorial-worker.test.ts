import assert from "node:assert/strict";
import test from "node:test";
import { createDormantEditorialWorker } from "./editorial-worker.js";

const config = { host: "redis", port: 6379, password: "test" };

test("editorial factory denies missing approval or handler", () => {
  const handler = async () => ({
    candidatesRecorded: 1,
    needsEditorialReview: true as const,
  });
  assert.throws(() => createDormantEditorialWorker(config, false));
  assert.throws(() => createDormantEditorialWorker(config, true));
  assert.throws(() => createDormantEditorialWorker(config, false, handler));
});
