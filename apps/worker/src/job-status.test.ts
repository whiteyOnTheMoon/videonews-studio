import assert from "node:assert/strict";
import test from "node:test";
import { mapBullState, reconcileJobStatusBatch, validateCandidate } from "./job-status.js";
import type { Pool } from "pg";
import type { Queue } from "bullmq";

const candidate = {
  job_id: "b85b671e-f99b-483b-b124-855030fcf125",
  queue_job_id: "job-b85b671ef99b483bb124855030fcf125",
  kind: "research",
  status: "pending" as const,
};

test("status reconciliation verifies persisted job ID and task kind", () => {
  assert.doesNotThrow(() => validateCandidate(candidate));
  assert.throws(() => validateCandidate({ ...candidate, queue_job_id: "untrusted" }), /identifier/);
  assert.throws(() => validateCandidate({ ...candidate, kind: "probe" }), /Unsupported/);
  assert.throws(() => validateCandidate({ ...candidate, status: "done" as "pending" }), /Unsupported/);
});

test("BullMQ state maps explicitly without guessing on missing jobs", () => {
  assert.equal(mapBullState("waiting", 0), "pending");
  assert.equal(mapBullState("active", 0), "running");
  assert.equal(mapBullState("delayed", 1), "retry");
  assert.equal(mapBullState("waiting", 1), "retry");
  assert.equal(mapBullState("completed", 1), "done");
  assert.equal(mapBullState("failed", 3), "failed");
  assert.equal(mapBullState("unknown", 1), null);
  assert.throws(() => mapBullState("unrecognized", 1), /Unrecognized/);
  assert.throws(() => mapBullState("completed", Number.NaN), /attempt count/);
  assert.throws(() => mapBullState("completed", 21), /attempt count/);
});

test("reconciler refuses invalid batch sizes before connecting", async () => {
  for (const size of [0, -1, 11, 1.5, NaN]) {
    await assert.rejects(reconcileJobStatusBatch({} as Pool, {} as Queue, size), /limit/);
  }
});
