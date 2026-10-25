import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { readDedicatedPostgresConfig } from "./runtime-db.js";
import { readEditorialQueueRoute } from "./editorial-routing.js";
import { readQueueConfig, QUEUE_PREFIX } from "./queue.js";
import { reconcileJobStatusBatch } from "./job-status.js";

// Intentionally separate from the normal probe worker and from the dispatcher.
// Even enabling --profile worker does not start this process.
// Operator must independently approve DB persistence, recovery and credentials.
if (process.env.VNS_STATUS_RECONCILE_ENABLED !== "true") {
  throw new Error("Job status reconciler must be explicitly enabled");
}
const editorialQueue = readEditorialQueueRoute("statusSync");
const redisConfig = readQueueConfig();
const dbConfig = readDedicatedPostgresConfig("statusSync");

const { Pool } = pg;
const pool = new Pool({
  ...dbConfig,
  max: 1,
  connectionTimeoutMillis: 4000,
  idleTimeoutMillis: 5000,
  statement_timeout: 12000,
});
const redis = new Redis({
  host: redisConfig.host,
  port: redisConfig.port,
  username: "vns_worker",
  password: redisConfig.password,
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  enableOfflineQueue: false,
});
const queue = new Queue(editorialQueue, { connection: redis, prefix: QUEUE_PREFIX });
queue.on("error", () => console.error("Job status Redis connection error"));
let running = true;
process.once("SIGTERM", () => {
  running = false;
});
process.once("SIGINT", () => {
  running = false;
});

try {
  while (running) {
    await reconcileJobStatusBatch(pool, queue, 10);
    // Bounded polling; neither a tight loop nor a worker handler.
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
  }
} catch {
  // Stop rather than give a dashboard a falsely optimistic state.
  console.error("Job status reconciler stopped after failure");
  process.exitCode = 1;
} finally {
  await Promise.allSettled([queue.close(), pool.end()]);
  await redis.quit().catch(() => undefined);
}
