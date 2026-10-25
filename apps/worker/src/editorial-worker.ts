import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createEditorialProcessor } from "./editorial-process.js";
import type { ResearchProcessorResult } from "./research-process.js";
import { QUEUE_NAME, QUEUE_PREFIX, type QueueConfig } from "./queue.js";

/**
 * Not imported by the running probe-only entrypoint. Deliberately does not
 * auto-run. A future dedicated, reviewed CLI must explicitly call worker.run().
 * No discovery/fetch/storage adapter is installed here.
 */
export function createDormantEditorialWorker(
  config: QueueConfig,
  enabled: boolean,
  researchHandler?: (job: Job) => Promise<ResearchProcessorResult>,
): { worker: Worker; connection: Redis } {
  if (enabled !== true || typeof researchHandler !== "function") {
    throw new Error("Editorial worker requires explicit authorization and research handler");
  }
  const processor = createEditorialProcessor(researchHandler);
  const connection = new Redis({
    host: config.host,
    port: config.port,
    username: "vns_worker",
    password: config.password,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  const worker = new Worker(QUEUE_NAME, processor, {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency: 1,
    autorun: false,
  });
  return { worker, connection };
}
