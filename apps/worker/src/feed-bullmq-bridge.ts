import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  createDormantFeedQueueContract,
  ISOLATED_FEED_QUEUE,
} from "./feed-queue-contract.js";
import type { OfflineFeedScheduler } from "./feed-scheduler-composition.js";

/** Deliberately outside the existing probe/research prefixes. */
export const ISOLATED_FEED_REDIS_PREFIX = "bull:vns:feed" as const;

export interface FeedBridgePorts {
  /** Caller-owned connections. This factory does not read passwords or open Redis itself. */
  producer: Redis;
  consumer: Redis;
  /** Injectable UTC clock; no queue-sourced or browser-sourced timestamp is trusted. */
  now: () => Date;
}

export interface GatedFeedBullmqBridge {
  readonly queue: Queue;
  readonly worker: Worker;
  /** Explicit single-slot dispatch; there is no timer or repeat schedule. */
  enqueue(now: Date): Promise<string>;
  /** Does not close caller-owned Redis connections. */
  close(): Promise<void>;
}

/**
 * A real BullMQ queue and consumer, constructed only after a second operator
 * acknowledgement on top of the existing scheduler/queue feature gates.
 * Never imported by apps/worker/src/index.ts. Production connections, role
 * credentials, source rights and a scheduler remain separate operator tasks.
 */
export function createGatedFeedBullmqBridge(
  env: NodeJS.ProcessEnv,
  scheduler: OfflineFeedScheduler,
  ports: FeedBridgePorts,
): GatedFeedBullmqBridge {
  if (
    env.VNS_FEED_BULLMQ_BRIDGE_ENABLED !== "true" ||
    env.VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_QUEUE_CONTRACT_ENABLED !== "true" ||
    env.VNS_FEED_QUEUE_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_OFFLINE_COMPOSITION_ENABLED !== "true" ||
    env.VNS_FEED_OFFLINE_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_QUEUE_NAME !== ISOLATED_FEED_QUEUE
  ) {
    throw new Error("Feed BullMQ bridge disabled");
  }
  if (
    !scheduler ||
    typeof scheduler.tick !== "function" ||
    !Array.isArray(scheduler.sourceIds) ||
    scheduler.sourceIds.length < 3 ||
    scheduler.sourceIds.length > 5 ||
    new Set(scheduler.sourceIds).size !== scheduler.sourceIds.length ||
    scheduler.sourceIds.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9_-]{2,40}$/.test(id)) ||
    !ports ||
    !ports.producer ||
    !ports.consumer ||
    ports.producer === ports.consumer ||
    typeof ports.now !== "function"
  ) {
    throw new Error("Feed BullMQ bridge ports refused");
  }
  const queue = new Queue(ISOLATED_FEED_QUEUE, {
    connection: ports.producer,
    prefix: ISOLATED_FEED_REDIS_PREFIX,
  });
  const contract = createDormantFeedQueueContract(env, scheduler, queue);
  const worker = new Worker(
    ISOLATED_FEED_QUEUE,
    async (job) => {
      const now = ports.now();
      return contract.process(
        {
          id: job.id,
          name: job.name,
          queueName: ISOLATED_FEED_QUEUE,
          data: job.data,
        },
        now,
      );
    },
    {
      connection: ports.consumer,
      prefix: ISOLATED_FEED_REDIS_PREFIX,
      concurrency: 1,
      autorun: true,
    },
  );
  let closing: Promise<void> | null = null;
  return {
    queue,
    worker,
    enqueue: (now: Date) => contract.enqueue(now),
    close: () => {
      closing ??= (async () => {
        await worker.close();
        await queue.close();
      })();
      return closing;
    },
  };
}
