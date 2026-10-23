// P1-07 disposable integration test; never execute against persistent Redis.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { createProbeWorker, QUEUE_NAME, QUEUE_PREFIX } from "../apps/worker/dist/queue.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("Integration test is GitHub Actions only");
}

const password = readFileSync(process.env.VNS_TEST_REDIS_PASSWORD_FILE, "utf8").trim();
const settings = {
  host: "127.0.0.1",
  port: 16379,
  username: "vns_worker",
  password,
};

const producerConnection = new Redis({ ...settings, maxRetriesPerRequest: 1 });
const eventConnection = new Redis({ ...settings, maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection: producerConnection, prefix: QUEUE_PREFIX });
const events = new QueueEvents(QUEUE_NAME, { connection: eventConnection, prefix: QUEUE_PREFIX });
const { worker, connection } = createProbeWorker(settings);
worker.on("error", () => {
  // Do not leak connection configuration or credentials.
  console.error("Worker Redis error");
});
try {
  await events.waitUntilReady();
  await worker.waitUntilReady();
  const job = await queue.add("probe", { kind: "probe" }, {
    jobId: "p107probe",
    attempts: 2,
    backoff: { type: "fixed", delay: 500 },
    removeOnComplete: true,
    removeOnFail: false,
  });
  const result = await job.waitUntilFinished(events, 15000);
  assert.deepEqual(result, { ok: true });
  assert.equal(worker.opts.concurrency, 1);
  console.log("PASS: ACL-authenticated BullMQ probe job, concurrency 1");
} finally {
  await Promise.allSettled([worker.close(), events.close(), queue.close()]);
  await Promise.allSettled([connection.quit(), producerConnection.quit(), eventConnection.quit()]);
}
