import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { readDedicatedPostgresConfig } from "./runtime-db.js";
import { readEditorialQueueRoute } from "./editorial-routing.js";
import { readQueueConfig, QUEUE_PREFIX } from "./queue.js";
import { dispatchOutboxBatch } from "./outbox.js";

// Separate, opt-in process. This is NOT run by the normal worker entrypoint.
// Do not enable in the VPS without a reviewed PG/Redis recovery policy and
// operator approval. Only enqueues; does not process editorial side effects.
if (process.env.VNS_OUTBOX_DISPATCH_ENABLED !== "true") {
  throw new Error("Outbox dispatch must be separately enabled");
}
const editorialQueue = readEditorialQueueRoute("dispatch");
const redisConfig = readQueueConfig();

const dbConfig = readDedicatedPostgresConfig("dispatch");

const { Pool } = pg;
const pool = new Pool({
  ...dbConfig,
  max: 1,
  connectionTimeoutMillis: 4000,
  idleTimeoutMillis: 5000,
  statement_timeout: 12000,
});
const redisConnection = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  username: "vns_worker",
  password: redisConfig.password,
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  enableOfflineQueue: false,
});
const queue = new Queue(editorialQueue, {
  connection: redisConnection,
  prefix: QUEUE_PREFIX,
});
let enabled = true;
process.once("SIGTERM", () => {
  enabled = false;
});
process.once("SIGINT", () => {
  enabled = false;
});
queue.on("error", () => console.error("Outbox queue connection error"));

try {
  while (enabled) {
    const result = await dispatchOutboxBatch(pool, queue);
    // Bound polling even when rows are already enqueued and retained.
    await new Promise<void>((resolve) => setTimeout(resolve, result.examined > 0 ? 1500 : 3000));
  }
} catch {
  console.error("Outbox dispatcher failed closed");
  process.exitCode = 1;
} finally {
  await Promise.allSettled([queue.close(), pool.end()]);
  await redisConnection.quit().catch(() => undefined);
}
