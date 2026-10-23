// GitHub Actions only: PostgreSQL outbox delivery to disposable authenticated Redis.
// No real worker is started: editorial jobs must never execute during this test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { dispatchOutboxBatch } from "../apps/worker/dist/outbox.js";
import { QUEUE_NAME, QUEUE_PREFIX } from "../apps/worker/dist/queue.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("Outbox integration test is GitHub Actions only");
}
const passwordFile = process.env.VNS_TEST_REDIS_PASSWORD_FILE;
if (!passwordFile || !passwordFile.startsWith("/tmp/")) {
  throw new Error("Disposable Redis secret required");
}

const { Pool } = pg;
const pool = new Pool({
  host: "127.0.0.1",
  port: 15432,
  database: "videonews",
  user: "vns",
  password: "ci-outbox-test-only-not-a-real-secret",
  connectionTimeoutMillis: 4000,
  max: 2,
});
const redis = new Redis({
  host: "127.0.0.1",
  port: 16379,
  username: "vns_worker",
  password: readFileSync(passwordFile, "utf8").trimEnd(),
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
const queue = new Queue(QUEUE_NAME, { connection: redis, prefix: QUEUE_PREFIX });

async function create(kind, key) {
  const { rows } = await pool.query(
    "SELECT vns.create_job_with_outbox($1, $2) AS id",
    [kind, key],
  );
  return rows[0].id;
}
async function outbox(id) {
  const { rows } = await pool.query(
    "SELECT delivery_state, dispatch_attempts, queue_job_id FROM vns.job_outbox WHERE job_id = $1",
    [id],
  );
  return rows[0];
}
const bullId = (id) => "job-" + id.replaceAll("-", "");

try {
  const id = await create("research", "ci-outbox-1");
  assert.equal(await create("research", "ci-outbox-1"), id);
  assert.equal((await outbox(id)).delivery_state, "pending");
  const first = await dispatchOutboxBatch(pool, queue);
  assert.equal(first.newlyEnqueued, 1);
  assert.equal((await outbox(id)).delivery_state, "enqueued");
  const redisJob = await queue.getJob(bullId(id));
  assert.equal(redisJob.name, "research");
  assert.deepEqual(redisJob.data, { kind: "research", jobId: id });
  assert.equal(redisJob.opts.removeOnComplete, false);
  const again = await dispatchOutboxBatch(pool, queue);
  assert.equal(again.newlyEnqueued, 0);
  assert.equal((await queue.getJobCounts("waiting")).waiting, 1);
  console.log("PASS: database idempotency + deterministic Redis delivery");

  // Simulate successful Redis enqueue followed by lost PG acknowledgement.
  const second = await create("script", "ci-outbox-2");
  const lostAcknowledge = {
    getJob: (key) => queue.getJob(key),
    add: async (...args) => {
      await queue.add(...args);
      throw new Error("ci-after-redis-before-postgres");
    },
  };
  await assert.rejects(dispatchOutboxBatch(pool, lostAcknowledge), /safe to retry/);
  assert.equal((await outbox(second)).delivery_state, "pending");
  assert.ok(await queue.getJob(bullId(second)));
  assert.equal((await dispatchOutboxBatch(pool, queue)).newlyEnqueued, 0);
  assert.equal((await outbox(second)).delivery_state, "enqueued");
  console.log("PASS: crash window Redis->Postgres heals without double enqueue");

  // Redis loses a retained job: PostgreSQL ledger permits its reconstruction.
  await (await queue.getJob(bullId(second))).remove();
  assert.equal(await queue.getJob(bullId(second)), undefined);
  assert.equal((await dispatchOutboxBatch(pool, queue)).newlyEnqueued, 1);
  assert.ok(await queue.getJob(bullId(second)));
  console.log("PASS: missing Redis job rebuilt from durable PostgreSQL ledger");

  // Fail closed instead of accepting a Redis job ID with mismatched content.
  const third = await create("render", "ci-outbox-3");
  await queue.add("probe", { kind: "probe", jobId: third }, {
    jobId: bullId(third),
    removeOnComplete: false,
  });
  await assert.rejects(dispatchOutboxBatch(pool, queue), /safe to retry/);
  assert.equal((await outbox(third)).delivery_state, "pending");
  await (await queue.getJob(bullId(third))).remove();
  assert.equal((await dispatchOutboxBatch(pool, queue)).newlyEnqueued, 1);
  assert.equal((await outbox(third)).delivery_state, "enqueued");
  console.log("PASS: conflicting Redis job fails closed and remains recoverable");

  // Terminal editorial jobs must never be redispatched after Redis loss.
  await pool.query("UPDATE vns.jobs SET status = 'done' WHERE id = $1", [id]);
  await (await queue.getJob(bullId(id))).remove();
  assert.equal((await dispatchOutboxBatch(pool, queue)).newlyEnqueued, 0);
  assert.equal(await queue.getJob(bullId(id)), undefined);
  console.log("PASS: finished PostgreSQL jobs are not inadvertently replayed");
} finally {
  await Promise.allSettled([queue.close(), pool.end()]);
  await redis.quit().catch(() => undefined);
}
