import assert from "node:assert/strict";
import test from "node:test";
import { createHealth, PRODUCT_NAME } from "./index.js";

test("shared product name and health payload are stable", () => {
  assert.equal(PRODUCT_NAME, "VideoNews Studio");
  assert.deepEqual(createHealth("api", new Date("2026-10-23T00:00:00Z")), {
    service: "api",
    status: "ok",
    timestamp: "2026-10-23T00:00:00.000Z",
  });
});
