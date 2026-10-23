import assert from "node:assert/strict";
import test from "node:test";
import { readWorkerConfig } from "./config.js";

test("worker defaults to one concurrent render", () => {
  assert.equal(readWorkerConfig({}).maxRenderConcurrency, 1);
});

test("worker rejects unapproved render parallelism", () => {
  assert.throws(() => readWorkerConfig({ MAX_RENDER_CONCURRENCY: "2" }), /requires/);
  assert.throws(() => readWorkerConfig({ MAX_RENDER_CONCURRENCY: "0" }), /requires/);
});
