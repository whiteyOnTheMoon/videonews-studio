import { readFileSync } from "node:fs";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_PREFIX } from "./queue.js";
import {
  createDormantProviderJobProcessor,
  type NamedProviderJobVerifier,
} from "./provider-job-processor.js";
import type { dormantOneShotTextCoordinator } from "./provider-one-shot-text-coordinator.js";

/**
 * Dedicated runtime boundary. Never imported by the production probe worker.
 * Constructing a worker never starts queue processing or vendor dispatch.
 * No provider key, PostgreSQL role or transport is read by this module.
 */
export const PROVIDER_QUEUE = "vns-provider-text" as const;
export const PROVIDER_REDIS_USER = "vns_provider" as const;
export const PROVIDER_REDIS_PASSWORD_FILE = "/run/secrets/redis_provider_password" as const;

export type ProviderQueueConfig = Readonly<{
  host: "redis";
  port: 6379;
  username: typeof PROVIDER_REDIS_USER;
  password: string;
}>;

export function readProviderQueueConfig(
  env: NodeJS.ProcessEnv = process.env,
  readSecret: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ProviderQueueConfig {
  if (
    env.VNS_P1_PROVIDER_QUEUE_ENABLED !== "true" ||
    env.VNS_P1_PROVIDER_QUEUE_OPERATOR_ACK !== "true" ||
    env.VNS_P1_PROVIDER_QUEUE_NAME !== PROVIDER_QUEUE ||
    env.VNS_P1_PROVIDER_REDIS_PASSWORD_FILE !== PROVIDER_REDIS_PASSWORD_FILE ||
    env.VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED === "true" ||
    env.VNS_P1_PROVIDER_CANARY_ENABLED === "true"
  ) {
    throw new Error("Provider queue runtime disabled");
  }
  let password: string;
  try {
    password = readSecret(PROVIDER_REDIS_PASSWORD_FILE).trimEnd();
  } catch {
    throw new Error("Provider Redis credential unavailable");
  }
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(password)) {
    throw new Error("Provider Redis credential unavailable");
  }
  return Object.freeze({ host: "redis", port: 6379, username: PROVIDER_REDIS_USER, password });
}

/**
 * Strictly separate Redis principal and queue. No retry handler, scheduler,
 * producer, auto-run or implicit activation. Real operator authorization,
 * job provenance and SQL admission are additional mandatory release gates.
 */
export function createDormantProviderQueueWorker(
  config: ProviderQueueConfig,
  coordinator: Pick<ReturnType<typeof dormantOneShotTextCoordinator>, "run">,
  verify: NamedProviderJobVerifier,
  enabled = false,
): { worker: Worker; connection: Redis } {
  if (
    enabled !== true ||
    !config ||
    config.host !== "redis" ||
    config.port !== 6379 ||
    config.username !== PROVIDER_REDIS_USER ||
    !/^[A-Za-z0-9_-]{40,256}$/.test(config.password)
  ) {
    throw new Error("Provider queue worker disabled");
  }
  const processor = createDormantProviderJobProcessor(coordinator, verify, true);
  const connection = new Redis({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  const worker = new Worker(PROVIDER_QUEUE, (job: Job) => processor(job), {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency: 1,
    autorun: false,
    maxStalledCount: 0,
  });
  return { worker, connection };
}
