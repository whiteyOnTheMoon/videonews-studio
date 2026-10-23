import assert from "node:assert/strict";
import test from "node:test";
import { dispatchOutboxBatch, validateOutboxRow } from "./outbox.js";
import type { Pool } from "pg";
import type { Queue } from "bullmq";

const valid = {
  job_id: "b85b671e-f99b-483b-b124-855030fcf125",
  queue_job_id: "job-b85b671ef99b483bb124855030fcf125",
  kind: "research",
  max_attempts: 3,
  delivery_state: "pending" as const,
};

test("valid outbox rows require fixed deterministic Redis IDs", () => {
  assert.doesNotThrow(() => validateOutboxRow(valid));
  assert.throws(
    () => validateOutboxRow({ ...valid, queue_job_id: "arbitrary" }),
    /deterministic queue ID/,
  );
  assert.throws(() => validateOutboxRow({ ...valid, kind: "probe" }), /Unsupported editorial/);
  assert.throws(() => validateOutboxRow({ ...valid, max_attempts: 21 }), /retry count/);
});

test("reconciler rejects unbounded batch sizes before touching Postgres", async () => {
  for (const limit of [0, 11, -1, 1.2, Number.NaN]) {
    await assert.rejects(dispatchOutboxBatch({} as Pool, {} as Queue, limit), /batch limit/);
  }
});
