import assert from "node:assert/strict";
import test from "node:test";
import { mapBullState, reconcileJobStatusBatch, validateCandidate } from "./job-status.js";
import type { Pool } from "pg";
import type { Queue } from "bullmq";

const candidate = {
  job_id: "b85b671e-f99b-483b-b124-855030fcf125",
  queue_job_id: "job-b85b671ef99b483bb124855030fcf125",
  kind: "research",
  max_attempts: 3,
  status: "pending" as const,
};

test("status reconciliation verifies persisted job ID and task kind", () => {
  assert.doesNotThrow(() => validateCandidate(candidate));
  assert.throws(() => validateCandidate({ ...candidate, max_attempts: 21 }), /retry policy/);
  assert.throws(() => validateCandidate({ ...candidate, queue_job_id: "untrusted" }), /identifier/);
  assert.throws(() => validateCandidate({ ...candidate, kind: "probe" }), /Unsupported/);
  assert.throws(
    () => validateCandidate({ ...candidate, status: "done" as "pending" }),
    /Unsupported/,
  );
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

test("status sync fails closed when Redis claims more attempts than PostgreSQL allows", async () => {
  const queries: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT j.id::text")) return { rows: [candidate] };
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const queue = {
    getJob: async () => ({
      id: candidate.queue_job_id,
      name: candidate.kind,
      data: { kind: candidate.kind, jobId: candidate.job_id },
      opts: {
        attempts: candidate.max_attempts,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: false,
        removeOnFail: false,
      },
      attemptsMade: 4,
      getState: async () => "failed",
    }),
  } as unknown as Queue;

  await assert.rejects(reconcileJobStatusBatch(pool, queue), /reconciliation failed/);
  assert.ok(queries.some((sql) => sql === "ROLLBACK"));
  assert.ok(!queries.some((sql) => sql.includes("UPDATE vns.jobs")));
  assert.equal(released, true);
});

test("missing Redis job preserves persisted status and reports missing count", async () => {
  const sql: string[] = [];
  let released = false;
  const client = {
    async query(statement: string) {
      sql.push(statement);
      if (statement.includes("SELECT j.id::text")) return { rows: [candidate] };
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const queue = { getJob: async () => null } as unknown as Queue;
  assert.deepEqual(await reconcileJobStatusBatch(pool, queue), {
    examined: 1,
    updated: 0,
    missingRedis: 1,
  });
  assert.ok(sql.includes("COMMIT"));
  assert.ok(!sql.some((query) => query.includes("UPDATE vns.jobs")));
  assert.equal(released, true);
});

test("Redis connection errors roll back without changing PostgreSQL status", async () => {
  const sql: string[] = [];
  let released = false;
  const client = {
    async query(statement: string) {
      sql.push(statement);
      if (statement.includes("SELECT j.id::text")) return { rows: [candidate] };
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const queue = {
    getJob: async () => {
      throw new Error("CI simulated Redis outage");
    },
  } as unknown as Queue;
  await assert.rejects(reconcileJobStatusBatch(pool, queue), /reconciliation failed/);
  assert.ok(sql.includes("ROLLBACK"));
  assert.ok(!sql.includes("COMMIT"));
  assert.ok(!sql.some((query) => query.includes("UPDATE vns.jobs")));
  assert.equal(released, true);
});
