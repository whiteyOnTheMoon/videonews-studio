import { readFeedRuntimeAdmission } from "./feed-runtime-admission.js";
import { requireSeparatedFeedGate } from "./feed-bullmq-separated.js";

const SLOT_MS = 900_000;
const START_WINDOW_MS = 90_000;
const MAX_CLOCK_ROLLBACK_MS = 1_000;

export interface FeedQueueSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
  queuePaused: boolean;
  oldestPendingAt: number | null;
}

export interface ContinuousFeedPolicy {
  maxBacklog: number;
  maxCompletedJobs: number;
  maxPendingAgeMinutes: number;
  maxConsecutiveEnqueueFailures: number;
}

export interface ContinuousFeedPorts {
  now(): Date;
  delay(ms: number, signal: AbortSignal): Promise<void>;
  inspect(): Promise<FeedQueueSnapshot>;
  enqueue(now: Date): Promise<string>;
  record(
    event: "slot_enqueued" | "enqueue_failed" | "queue_unhealthy" | "clock_invalid",
    fields: { slot: number; pending: number; failed: number },
  ): void;
}

export function readContinuousFeedPolicy(env: NodeJS.ProcessEnv): ContinuousFeedPolicy {
  requireSeparatedFeedGate(env, "producer", "continuous_producer");
  readFeedRuntimeAdmission(env, "continuous_producer");
  if (
    env.VNS_FEED_CONTINUOUS_ENABLED !== "true" ||
    env.VNS_FEED_CONTINUOUS_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_SCHEDULER_ENABLED !== "true" ||
    env.VNS_FEED_SCHEDULER_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_SCHEDULER_MODE !== "continuous" ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false"
  ) {
    throw new Error("Continuous feed scheduling not authorized");
  }
  const values = [
    env.VNS_FEED_CONTINUOUS_MAX_BACKLOG,
    env.VNS_FEED_CONTINUOUS_MAX_COMPLETED_JOBS,
    env.VNS_FEED_CONTINUOUS_MAX_PENDING_AGE_MINUTES,
    env.VNS_FEED_CONTINUOUS_ENQUEUE_FAILURE_LIMIT,
  ];
  if (values.some((value) => typeof value !== "string" || !/^[1-9][0-9]{0,5}$/.test(value))) {
    throw new Error("Continuous feed limits invalid");
  }
  const maxBacklog = Number(values[0]);
  const maxCompletedJobs = Number(values[1]);
  const maxPendingAgeMinutes = Number(values[2]);
  const maxConsecutiveEnqueueFailures = Number(values[3]);
  if (maxBacklog > 20 || maxCompletedJobs < 100 || maxCompletedJobs > 100000 ||
    maxPendingAgeMinutes < 15 || maxPendingAgeMinutes > 29 ||
    maxConsecutiveEnqueueFailures > 3) {
    throw new Error("Continuous feed limits invalid");
  }
  return Object.freeze({ maxBacklog, maxCompletedJobs, maxPendingAgeMinutes, maxConsecutiveEnqueueFailures });
}

export function validateFeedQueueSnapshot(
  snapshot: FeedQueueSnapshot,
  policy: ContinuousFeedPolicy,
  now: number,
): number {
  if (!snapshot || !policy || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("Feed queue observation unavailable");
  }
  const counts = [
    snapshot.waiting, snapshot.active, snapshot.delayed, snapshot.failed,
    snapshot.completed, snapshot.paused,
  ];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 1_000_000)) {
    throw new Error("Feed queue observation unavailable");
  }
  const pending = snapshot.waiting + snapshot.active + snapshot.delayed + snapshot.paused;
  if (typeof snapshot.queuePaused !== "boolean" || snapshot.queuePaused ||
    snapshot.failed > 0 || snapshot.completed >= policy.maxCompletedJobs ||
    pending > policy.maxBacklog || snapshot.paused > 0) {
    throw new Error("Feed queue risk threshold exceeded");
  }
  const oldest = snapshot.oldestPendingAt;
  if (
    (pending === 0 && oldest !== null) ||
    (pending > 0 &&
      (!Number.isSafeInteger(oldest) || oldest === null || oldest > now ||
        oldest < 0 || now - oldest >= policy.maxPendingAgeMinutes * 60_000))
  ) {
    throw new Error("Feed queue risk threshold exceeded");
  }
  return pending;
}

/**
 * Continuous, explicitly approved 15-minute producer, with monitored state
 * every 30 seconds. Never replays missed slots or opens publisher/DB secrets.
 * BullMQ deterministic job IDs provide idempotency on restarts. Any failed
 * job, excessive/stale backlog or paused queue stops admission fail-closed.
 */
export async function runContinuousFeedSchedule(
  env: NodeJS.ProcessEnv,
  ports: ContinuousFeedPorts,
  signal: AbortSignal,
): Promise<void> {
  const policy = readContinuousFeedPolicy(env);
  if (
    !ports || !signal || typeof ports.now !== "function" ||
    typeof ports.delay !== "function" || typeof ports.inspect !== "function" ||
    typeof ports.enqueue !== "function" || typeof ports.record !== "function"
  ) {
    throw new Error("Continuous feed ports invalid");
  }
  let lastSlot = -1;
  let lastClock = -1;
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    const current = ports.now();
    const now = current instanceof Date ? current.getTime() : NaN;
    if (!Number.isSafeInteger(now) || now < 0 ||
      (lastClock >= 0 && now < lastClock - MAX_CLOCK_ROLLBACK_MS)) {
      ports.record("clock_invalid", { slot: lastSlot, pending: 0, failed: 0 });
      throw new Error("Continuous feed clock unavailable");
    }
    lastClock = Math.max(lastClock, now);
    const slot = Math.floor(now / SLOT_MS);
    let snapshot: FeedQueueSnapshot;
    let pending = 0;
    try {
      snapshot = await ports.inspect();
      pending = validateFeedQueueSnapshot(snapshot, policy, now);
    } catch {
      ports.record("queue_unhealthy", { slot, pending: 0, failed: 0 });
      throw new Error("Continuous feed queue health check failed");
    }
    if (signal.aborted) return;
    if (slot > lastSlot && now % SLOT_MS < START_WINDOW_MS) {
      lastSlot = slot;
      try {
        await ports.enqueue(current);
        consecutiveFailures = 0;
        ports.record("slot_enqueued", { slot, pending, failed: 0 });
      } catch {
        consecutiveFailures++;
        ports.record("enqueue_failed", { slot, pending, failed: consecutiveFailures });
        if (consecutiveFailures >= policy.maxConsecutiveEnqueueFailures) {
          throw new Error("Continuous feed dispatch halted");
        }
      }
    }
    if (signal.aborted) return;
    const untilNext = SLOT_MS - (now % SLOT_MS);
    try {
      await ports.delay(Math.min(30_000, untilNext), signal);
    } catch {
      if (!signal.aborted) throw new Error("Continuous feed timer unavailable");
    }
  }
}
