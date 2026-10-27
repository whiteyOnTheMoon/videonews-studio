import type { OfflineFeedScheduler } from "./feed-scheduler-composition.js";
import type { PollResult } from "./feed-poller.js";

export const ISOLATED_FEED_QUEUE = "vns-feed-poll" as const;
export const FEED_TICK_JOB_NAME = "feed-tick" as const;

const SLOT_MS = 15 * 60 * 1000;
const MAX_LAG_MS = 2 * SLOT_MS;

export interface FeedTickData {
  kind: typeof FEED_TICK_JOB_NAME;
  slot: number;
}

export interface FeedQueuePort {
  readonly name: string;
  add(
    name: typeof FEED_TICK_JOB_NAME,
    data: FeedTickData,
    options: {
      jobId: string;
      attempts: 1;
      removeOnComplete: false;
      removeOnFail: false;
    },
  ): Promise<unknown>;
}

export interface FeedTickDelivery {
  id: string | undefined;
  name: string;
  queueName: string;
  data: unknown;
}

export interface FeedTickSummary {
  ok: true;
  sourcesExamined: number;
  candidatesAdded: number;
  notModified: number;
}

function requireGate(env: NodeJS.ProcessEnv): void {
  if (
    env.VNS_FEED_QUEUE_CONTRACT_ENABLED !== "true" ||
    env.VNS_FEED_QUEUE_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_OFFLINE_COMPOSITION_ENABLED !== "true" ||
    env.VNS_FEED_OFFLINE_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_QUEUE_NAME !== ISOLATED_FEED_QUEUE
  ) {
    throw new Error("Feed queue remains disabled");
  }
}

function slotAt(now: Date): number {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) || now.getTime() < 0) {
    throw new Error("Feed queue clock invalid");
  }
  const slot = Math.floor(now.getTime() / SLOT_MS);
  if (!Number.isSafeInteger(slot)) throw new Error("Feed queue clock invalid");
  return slot;
}

function jobId(slot: number): string {
  return "vns-feed-tick-" + slot;
}

function validDelivery(job: FeedTickDelivery, now: Date): boolean {
  if (
    !job ||
    job.queueName !== ISOLATED_FEED_QUEUE ||
    job.name !== FEED_TICK_JOB_NAME ||
    !job.data ||
    typeof job.data !== "object" ||
    Array.isArray(job.data)
  ) {
    return false;
  }
  const data = job.data as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    data.kind !== FEED_TICK_JOB_NAME ||
    typeof data.slot !== "number" ||
    !Number.isSafeInteger(data.slot) ||
    data.slot < 0 ||
    job.id !== jobId(data.slot)
  ) {
    return false;
  }
  const elapsed = now.getTime() - data.slot * SLOT_MS;
  return elapsed >= 0 && elapsed < MAX_LAG_MS;
}

/**
 * No Redis connection, Cron, timer, Worker, Queue or schedule is instantiated.
 * Caller must explicitly pass a future isolated BullMQ queue and a separately
 * approved server-built feed scheduler; the running probe worker never imports this.
 */
export function createDormantFeedQueueContract(
  env: NodeJS.ProcessEnv,
  scheduler: OfflineFeedScheduler,
  queue: FeedQueuePort,
): {
  enqueue(now: Date): Promise<string>;
  process(job: FeedTickDelivery, now: Date): Promise<FeedTickSummary>;
} {
  requireGate(env);
  if (
    !queue ||
    queue.name !== ISOLATED_FEED_QUEUE ||
    typeof queue.add !== "function" ||
    !scheduler ||
    typeof scheduler.tick !== "function" ||
    !Array.isArray(scheduler.sourceIds) ||
    scheduler.sourceIds.length < 3 ||
    scheduler.sourceIds.length > 5 ||
    scheduler.sourceIds.some(
      (id) => typeof id !== "string" || !/^[a-z][a-z0-9_-]{2,40}$/.test(id),
    ) ||
    new Set(scheduler.sourceIds).size !== scheduler.sourceIds.length
  ) {
    throw new Error("Feed queue ports not approved");
  }
  const approvedIds = new Set(scheduler.sourceIds);
  let processing = false;
  return {
    async enqueue(now: Date): Promise<string> {
      const slot = slotAt(now);
      const id = jobId(slot);
      try {
        await queue.add(
          FEED_TICK_JOB_NAME,
          { kind: FEED_TICK_JOB_NAME, slot },
          {
            jobId: id,
            attempts: 1,
            removeOnComplete: false,
            removeOnFail: false,
          },
        );
      } catch {
        throw new Error("Feed queue enqueue unavailable");
      }
      return id;
    },
    async process(job: FeedTickDelivery, now: Date): Promise<FeedTickSummary> {
      slotAt(now);
      if (!validDelivery(job, now) || processing) {
        throw new Error("Feed queue delivery refused");
      }
      processing = true;
      try {
        const results: readonly PollResult[] = await scheduler.tick(now);
        if (!Array.isArray(results) || results.length > approvedIds.size) {
          throw new Error("Feed queue execution failed");
        }
        let candidatesAdded = 0;
        let notModified = 0;
        const seen = new Set<string>();
        for (const result of results) {
          if (
            !result ||
            !approvedIds.has(result.sourceId) ||
            seen.has(result.sourceId) ||
            !["ingested", "not_modified", "failed"].includes(result.status) ||
            !Number.isSafeInteger(result.newItems) ||
            result.newItems < 0 ||
            result.newItems > 20 ||
            (result.status !== "ingested" && result.newItems !== 0) ||
            result.status === "failed"
          ) {
            throw new Error("Feed queue execution failed");
          }
          seen.add(result.sourceId);
          candidatesAdded += result.newItems;
          if (result.status === "not_modified") notModified++;
        }
        return {
          ok: true,
          sourcesExamined: results.length,
          candidatesAdded,
          notModified,
        };
      } catch {
        // No SQL, DNS, feed XML, secrets or source URLs in the error.
        throw new Error("Feed queue execution failed");
      } finally {
        processing = false;
      }
    },
  };
}

/**
 * Producer-only path: a slot carries no source identity, URL, credentials or
 * authorization. Only the independent consumer may fetch, after fresh source,
 * DB and trust-anchor attestation. Unlike a queue processor, producers never
 * require or construct a synthetic scheduler.
 */
export function createGatedFeedSlotEnqueuer(
  env: NodeJS.ProcessEnv,
  queue: FeedQueuePort,
): (now: Date) => Promise<string> {
  requireGate(env);
  if (!queue || queue.name !== ISOLATED_FEED_QUEUE || typeof queue.add !== "function") {
    throw new Error("Feed producer queue refused");
  }
  return async (now: Date): Promise<string> => {
    const slot = slotAt(now);
    const id = jobId(slot);
    try {
      await queue.add(
        FEED_TICK_JOB_NAME,
        { kind: FEED_TICK_JOB_NAME, slot },
        { jobId: id, attempts: 1, removeOnComplete: false, removeOnFail: false },
      );
      return id;
    } catch {
      throw new Error("Feed queue enqueue unavailable");
    }
  };
}

/** Validate a Redis-delivered slot BEFORE opening database/anchor/source secrets. */
export function assertGatedFeedDelivery(
  env: NodeJS.ProcessEnv,
  job: FeedTickDelivery,
  now: Date,
): void {
  requireGate(env);
  slotAt(now);
  if (!validDelivery(job, now)) throw new Error("Feed queue delivery refused");
}
