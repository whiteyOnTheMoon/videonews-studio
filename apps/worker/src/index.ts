import { PRODUCT_NAME } from "@vns/shared";
import { readWorkerConfig } from "./config.js";
import { createProbeWorker, readQueueConfig } from "./queue.js";

// Explicitly opt-in; missing or malformed secrets prevent worker startup.
const config = readWorkerConfig();
const redis = readQueueConfig();
const { worker, connection } = createProbeWorker(redis);
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await worker.close();
    await connection.quit();
  } catch {
    // Credential and upstream error text are deliberately omitted.
    console.error("Worker shutdown error");
    process.exitCode = 1;
  }
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
worker.on("error", () => console.error("Worker Redis error (details omitted)"));

try {
  await worker.waitUntilReady();
  console.info(`${PRODUCT_NAME} probe worker ready (concurrency: ${config.maxRenderConcurrency}).`);
  console.info("Rendering, uploads and other side effects remain disabled.");
} catch {
  console.error("Worker could not connect to authenticated Redis");
  process.exitCode = 1;
  await shutdown();
}
