import { readFileSync } from "node:fs";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

export const QUEUE_NAME = "vns-jobs";
export const QUEUE_PREFIX = "bull:vns";

export interface QueueConfig {
  host: string;
  port: number;
  password: string;
}

export function readQueueConfig(
  env: NodeJS.ProcessEnv = process.env,
  readSecret: (path: string) => string = (path) => readFileSync(path, "utf8"),
): QueueConfig {
  if (env.VNS_WORKER_ENABLED !== "true") {
    throw new Error("Worker must be explicitly enabled");
  }
  if (env.VNS_REDIS_PASSWORD_FILE !== "/run/secrets/redis_password") {
    throw new Error("Worker requires the Redis password Docker secret");
  }
  const host = env.VNS_REDIS_HOST ?? "redis";
  const port = Number(env.VNS_REDIS_PORT ?? "6379");
  if (!["redis", "127.0.0.1"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Worker Redis connection configuration invalid");
  }
  let password: string;
  try {
    password = readSecret(env.VNS_REDIS_PASSWORD_FILE).trimEnd();
  } catch {
    throw new Error("Redis secret unavailable");
  }
  if (password.length < 40 || !/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error("Redis secret invalid");
  }
  return { host, port, password };
}

export async function processProbeJob(job: Job): Promise<{ ok: true }> {
  // P1-07 intentionally has *no* render, research, upload or editorial effects.
  // Unknown job kinds fail rather than being silently marked complete.
  if (job.name !== "probe" || job.data?.kind !== "probe" ||
      Object.keys(job.data).length !== 1) {
    throw new Error("Unsupported worker job");
  }
  return { ok: true };
}

export function createProbeWorker(config: QueueConfig): { worker: Worker; connection: Redis } {
  const connection = new Redis({
    host: config.host,
    port: config.port,
    username: "vns_worker",
    password: config.password,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  const worker = new Worker(QUEUE_NAME, processProbeJob, {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency: 1,
    autorun: true,
  });
  return { worker, connection };
}
