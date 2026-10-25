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
  assert.doesNotThrow(() => validateOutboxRow({ ...valid, delivery_state: "enqueued" }));
  for (const state of ["failed", "done", "", undefined]) {
    assert.throws(
      () => validateOutboxRow({ ...valid, delivery_state: state as never }),
      /delivery state invalid/,
    );
  }
  assert.throws(
    () => validateOutboxRow({ ...valid, queue_job_id: "arbitrary" }),
    /deterministic queue ID/,
  );
  for (const kind of ["probe", "script", "render", "upload"]) {
    assert.throws(() => validateOutboxRow({ ...valid, kind }), /Unsupported editorial/);
  }
  assert.throws(() => validateOutboxRow({ ...valid, max_attempts: 21 }), /retry count/);
});

test("reconciler rejects unbounded batch sizes before touching Postgres", async () => {
  for (const limit of [0, 11, -1, 1.2, Number.NaN]) {
    await assert.rejects(dispatchOutboxBatch({} as Pool, {} as Queue, limit), /batch limit/);
  }
});

test("Redis identity conflicts roll back without acknowledging the outbox", async () => {
  for (const mismatch of [
    { name: "render" },
    { data: { kind: "research", jobId: "different" } },
    { opts: { attempts: 99 } },
  ]) {
    const sql: string[] = [];
    let released = false;
    const client = {
      async query(statement: string) {
        sql.push(statement);
        if (statement.includes("SELECT ob.job_id::text")) return { rows: [valid] };
        return { rows: [], rowCount: 0 };
      },
      release() {
        released = true;
      },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const queue = {
      getJob: async () => ({
        name: valid.kind,
        data: { kind: valid.kind, jobId: valid.job_id },
        opts: {
          attempts: valid.max_attempts,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: false,
          removeOnFail: false,
        },
        ...mismatch,
      }),
      add: async () => {
        throw new Error("must not enqueue when existing job conflicts");
      },
    } as unknown as Queue;
    await assert.rejects(dispatchOutboxBatch(pool, queue), /Outbox delivery failed/);
    assert.ok(sql.includes("ROLLBACK"));
    assert.ok(!sql.some((statement) => statement.includes("UPDATE vns.job_outbox")));
    assert.equal(released, true);
  }
});
