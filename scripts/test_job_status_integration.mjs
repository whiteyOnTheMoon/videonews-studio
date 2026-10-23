// Disposable CI-only PostgreSQL+BullMQ lifecycle integration.
// Simulated editorial worker handlers never research, render, publish or upload.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { reconcileJobStatusBatch } from "../apps/worker/dist/job-status.js";
import { dispatchOutboxBatch } from "../apps/worker/dist/outbox.js";
import { QUEUE_NAME, QUEUE_PREFIX } from "../apps/worker/dist/queue.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("Status integration is GitHub Actions only");
}
const passwordFile = process.env.VNS_TEST_REDIS_PASSWORD_FILE;
if (!passwordFile || !passwordFile.startsWith("/tmp/")) {
  throw new Error("Disposable CI password file required");
}
const connectionSettings = {
  host: "127.0.0.1",
  port: 16379,
  username: "vns_worker",
  password: readFileSync(passwordFile, "utf8").trimEnd(),
};
const redis = new Redis({ ...connectionSettings, maxRetriesPerRequest: 1 });
const eventsConnection = new Redis({ ...connectionSettings, maxRetriesPerRequest: null });
const producer = new Queue(QUEUE_NAME, { connection: redis, prefix: QUEUE_PREFIX });
const events = new QueueEvents(QUEUE_NAME, { connection: eventsConnection, prefix: QUEUE_PREFIX });
const { Pool } = pg;
const db = new Pool({
  host: "127.0.0.1",
  port: 15432,
  user: "vns",
  database: "videonews",
  password: "ci-outbox-test-only-not-a-real-secret",
  connectionTimeoutMillis: 4000,
});
const workers = new Set();
const workerConnections = new Set();
events.on("error", () => console.error("CI job status event connection error"));

async function create(key) {
  const { rows } = await db.query(
    "SELECT vns.create_job_with_outbox('research', $1) AS id",
    [key],
  );
  const id = rows[0].id;
  assert.equal((await dispatchOutboxBatch(db, producer, 10)).newlyEnqueued, 1);
  const job = await producer.getJob("job-" + id.replaceAll("-", ""));
  assert.ok(job);
  return { id, job };
}
async function status(id) {
  const { rows } = await db.query(
    "SELECT status, attempt_count, error_code FROM vns.jobs WHERE id = $1",
    [id],
  );
  return rows[0];
}
async function sync() {
  return reconcileJobStatusBatch(db, producer, 10);
}
async function makeWorker(processor) {
  const connection = new Redis({ ...connectionSettings, maxRetriesPerRequest: null });
  workerConnections.add(connection);
  const worker = new Worker(QUEUE_NAME, processor, {
    connection, prefix: QUEUE_PREFIX, concurrency: 1,
  });
  worker.on("error", () => console.error("CI status worker error"));
  workers.add(worker);
  await worker.waitUntilReady();
  return worker;
}
async function closeWorker(worker) {
  await worker.close();
  workers.delete(worker);
}

try {
  await events.waitUntilReady();
  await producer.waitUntilReady();
  // Only CI's disposable Redis and DB are reachable by this process.
  await producer.obliterate({ force: true });
  await db.query("DELETE FROM vns.job_outbox");
  await db.query("DELETE FROM vns.jobs");

  const first = await create("ci-lifecycle-success");
  assert.deepEqual(await status(first.id), {
    status: "pending", attempt_count: 0, error_code: null,
  });
  assert.equal((await sync()).updated, 0);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active;
  const claimed = new Promise((resolve) => { active = resolve; });
  const worker = await makeWorker(async (job) => {
    assert.equal(job.name, "research");
    assert.equal(job.data.jobId, first.id);
    active();
    await gate;
    return { testOnly: true };
  });
  try {
    const finished = first.job.waitUntilFinished(events, 20000);
    await claimed;
    assert.equal((await sync()).updated, 1);
    assert.equal((await status(first.id)).status, "running");
    release();
    assert.deepEqual(await finished, { testOnly: true });
    assert.equal((await sync()).updated, 1);
    assert.equal((await status(first.id)).status, "done");
    assert.equal((await sync()).updated, 0);
  } finally {
    release();
    await closeWorker(worker);
  }
  await first.job.remove();
  assert.equal((await sync()).updated, 0);
  assert.equal((await status(first.id)).status, "done");
  console.log("PASS: real BullMQ active -> completed snapshots update PG exactly to terminal done");

  const failure = await create("ci-lifecycle-failed");
  let failEvent;
  const failed = new Promise((resolve) => { failEvent = resolve; });
  const failingWorker = await makeWorker(async (job) => {
    assert.equal(job.data.jobId, failure.id);
    throw new Error("ci-synthetic-failure-never-persist-raw");
  });
  failingWorker.on("failed", () => failEvent());
  try {
    await failed;
    assert.equal(await failure.job.getState(), "failed");
    assert.equal((await sync()).updated, 1);
    assert.deepEqual(await status(failure.id), {
      status: "failed", attempt_count: 1, error_code: "bullmq_failed",
    });
    assert.equal((await sync()).updated, 0);
  } finally {
    await closeWorker(failingWorker);
  }
  console.log("PASS: exhausted BullMQ retries lead to sanitized terminal failed status");

  const retry = await create("ci-lifecycle-retry");
  let attempts = 0;
  let signalFirstFailure;
  const firstFailure = new Promise((resolve) => { signalFirstFailure = resolve; });
  const retryWorker = await makeWorker(async (job) => {
    assert.equal(job.data.jobId, retry.id);
    attempts += 1;
    if (attempts === 1) {
      throw new Error("ci-transient");
    }
    return { testOnly: true };
  });
  retryWorker.on("failed", () => signalFirstFailure());
  try {
    // The dispatched BullMQ job has attempts:3 and backoff:1000ms.
    const done = retry.job.waitUntilFinished(events, 20000);
    await firstFailure;
    const pendingRetry = await retry.job.getState();
    assert.equal(pendingRetry, "delayed");
    assert.equal((await sync()).updated, 1);
    assert.deepEqual(await status(retry.id), {
      status: "retry", attempt_count: 1, error_code: null,
    });
    assert.deepEqual(await done, { testOnly: true });
    assert.equal(attempts, 2);
    assert.equal((await sync()).updated, 1);
    assert.equal((await status(retry.id)).status, "done");
  } finally {
    await closeWorker(retryWorker);
  }
  console.log("PASS: transient failed attempt -> retry -> done recorded in PostgreSQL");

  const missing = await create("ci-lifecycle-missing");
  await missing.job.remove();
  const snapshot = await sync();
  assert.equal(snapshot.missingRedis, 1);
  assert.equal((await status(missing.id)).status, "pending");
  assert.equal((await dispatchOutboxBatch(db, producer, 10)).newlyEnqueued, 1);
  console.log("PASS: missing Redis record never falsely marks PostgreSQL failed/done");

  const mismatch = await create("ci-lifecycle-collision");
  await mismatch.job.remove();
  await producer.add("probe", { kind: "probe", jobId: mismatch.id }, {
    jobId: "job-" + mismatch.id.replaceAll("-", ""),
    removeOnComplete: false,
  });
  await assert.rejects(sync(), /reconciliation failed/);
  assert.equal((await status(mismatch.id)).status, "pending");
  console.log("PASS: incompatible Redis job fails closed and DB status remains intact");
} finally {
  await Promise.allSettled([...workers].map((worker) => worker.close()));
  await Promise.allSettled([events.close(), producer.close(), db.end()]);
  await Promise.allSettled([...workerConnections, redis, eventsConnection].map((conn) => conn.quit()));
}
