import { readFileSync } from "node:fs";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { readQueueConfig, QUEUE_NAME, QUEUE_PREFIX } from "./queue.js";
import { dispatchOutboxBatch } from "./outbox.js";

// Separate, opt-in process. This is NOT run by the normal worker entrypoint.
// Do not enable in the VPS without a reviewed PG/Redis recovery policy and
// operator approval. Only enqueues; does not process editorial side effects.
if (process.env.VNS_OUTBOX_DISPATCH_ENABLED !== "true") {
  throw new Error("Outbox dispatch must be separately enabled");
}
const redisConfig = readQueueConfig();

const secretPath = process.env.VNS_POSTGRES_PASSWORD_FILE;
if (secretPath !== "/run/secrets/postgres_password") {
  throw new Error("Outbox requires the PostgreSQL Docker secret");
}
const dbHost = process.env.VNS_POSTGRES_HOST ?? "postgres";
const dbPort = Number(process.env.VNS_POSTGRES_PORT ?? "5432");
const dbName = process.env.VNS_POSTGRES_DB ?? "videonews";
if (
  !["postgres", "127.0.0.1"].includes(dbHost) ||
  !Number.isInteger(dbPort) ||
  dbPort < 1 ||
  dbPort > 65535 ||
  !/^[a-z][a-z0-9_]{0,62}$/.test(dbName)
) {
  throw new Error("Outbox database endpoint invalid");
}
let databasePassword: string;
try {
  databasePassword = readFileSync(secretPath, "utf8").trimEnd();
} catch {
  throw new Error("PostgreSQL secret unavailable");
}
if (databasePassword.length < 16) {
  throw new Error("PostgreSQL secret invalid");
}

const { Pool } = pg;
const pool = new Pool({
  host: dbHost,
  port: dbPort,
  user: "vns",
  database: dbName,
  password: databasePassword,
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
const queue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  prefix: QUEUE_PREFIX,
});
let enabled = true;
process.once("SIGTERM", () => { enabled = false; });
process.once("SIGINT", () => { enabled = false; });
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
