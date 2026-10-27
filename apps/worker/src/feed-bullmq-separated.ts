import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { readFeedRuntimeAdmission } from "./feed-runtime-admission.js";
import { readBoundedFeedSchedule } from "./bounded-feed-scheduler.js";
import {
  createDormantFeedQueueContract,
  assertGatedFeedDelivery,
  createGatedFeedSlotEnqueuer,
  ISOLATED_FEED_QUEUE,
  type FeedQueuePort,
} from "./feed-queue-contract.js";
import { ISOLATED_FEED_REDIS_PREFIX } from "./feed-bullmq-bridge.js";
import type { TrustedFeedContext } from "./feed-trusted-context.js";

export function requireSeparatedFeedGate(
  env: NodeJS.ProcessEnv,
  kind: "producer" | "consumer",
  mode: "bounded_producer" | "continuous_producer" = "bounded_producer",
): void {
  const enabled =
    kind === "producer" ? "VNS_FEED_SEPARATE_PRODUCER_ENABLED" : "VNS_FEED_SEPARATE_WORKER_ENABLED";
  const ack =
    kind === "producer"
      ? "VNS_FEED_SEPARATE_PRODUCER_OPERATOR_ACK"
      : "VNS_FEED_SEPARATE_WORKER_OPERATOR_ACK";
  if (
    env[enabled] !== "true" ||
    env[ack] !== "true" ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false" ||
    env.VNS_FEED_REDIS_USER?.startsWith(
      kind === "producer" ? "vns_feed_producer_" : "vns_feed_consumer_",
    ) !== true
  ) {
    throw new Error("Separated feed role not authorized");
  }
  readFeedRuntimeAdmission(env, kind === "producer" ? mode : "persistent_worker");
  if (kind === "producer" && mode === "bounded_producer") {
    readBoundedFeedSchedule(env, "bounded_producer");
  }
}

/** Persistent BullMQ slot producer. It cannot perform HTTP or SQL operations. */
export function createSeparatedFeedProducer(
  env: NodeJS.ProcessEnv,
  connection: Redis,
  mode: "bounded_producer" | "continuous_producer" = "bounded_producer",
) {
  requireSeparatedFeedGate(env, "producer", mode);
  if (!connection) throw new Error("Feed producer connection missing");
  const queue = new Queue(ISOLATED_FEED_QUEUE, {
    connection,
    prefix: ISOLATED_FEED_REDIS_PREFIX,
  });
  const enqueue = createGatedFeedSlotEnqueuer(env, queue);
  return {
    queue,
    enqueue,
    close: () => queue.close(),
  };
}

/**
 * A separate durable consumer process. Every job reopens/revalidates the
 * signed registry, trust anchor and the real restricted PostgreSQL login.
 * Jobs never carry a source URL; stale and forged slot IDs remain rejected
 * by the existing queue contract. One job at a time, no automatic retries.
 */
export function createSeparatedFeedConsumer(
  env: NodeJS.ProcessEnv,
  connection: Redis,
  openContext: () => Promise<TrustedFeedContext>,
  now: () => Date = () => new Date(),
) {
  requireSeparatedFeedGate(env, "consumer");
  if (!connection || typeof openContext !== "function" || typeof now !== "function") {
    throw new Error("Feed consumer ports unavailable");
  }
  const processingQueue: FeedQueuePort = {
    name: ISOLATED_FEED_QUEUE,
    async add() {
      throw new Error("Feed consumer cannot enqueue");
    },
  };
  const worker = new Worker(
    ISOLATED_FEED_QUEUE,
    async (job) => {
      const delivery = {
        id: job.id,
        name: job.name,
        queueName: ISOLATED_FEED_QUEUE,
        data: job.data,
      };
      const startedAt = now();
      assertGatedFeedDelivery(env, delivery, startedAt);
      let context: TrustedFeedContext | undefined;
      try {
        context = await openContext();
        const contract = createDormantFeedQueueContract(env, context.scheduler, processingQueue);
        return await contract.process(delivery, startedAt);
      } catch {
        throw new Error("Separated feed job refused or failed");
      } finally {
        await context?.close().catch(() => {
          throw new Error("Separated feed context cleanup failed");
        });
      }
    },
    {
      connection,
      prefix: ISOLATED_FEED_REDIS_PREFIX,
      concurrency: 1,
      autorun: true,
    },
  );
  return {
    worker,
    close: () => worker.close(),
  };
}
