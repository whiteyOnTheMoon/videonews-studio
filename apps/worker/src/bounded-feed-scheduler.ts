import { readFeedRuntimeAdmission, type FeedRuntimeMode } from "./feed-runtime-admission.js";
import type { FeedObservationSummary } from "./feed-observe-once.js";

const SLOT_MS = 15 * 60 * 1000;
const START_WINDOW_MS = 90 * 1000;
const MAX_TICKS = 16;
const MAX_CONSECUTIVE_FAILURES = 3;

export interface BoundedFeedSchedule {
  maxTicks: number;
  failureLimit: number;
}

export interface BoundedFeedSchedulePorts {
  now(): Date;
  delay(ms: number, signal: AbortSignal): Promise<void>;
  observe(): Promise<FeedObservationSummary>;
  /** Never include raw error text, source URLs or credentials in alarms. */
  record(
    event: "tick_ok" | "tick_failed" | "halted",
    fields: {
      slot: number;
      attempts: number;
      consecutiveFailures: number;
    },
  ): void;
}

/**
 * Bounded process-level scheduling over the existing signed, independently
 * anchored one-shot observer. Each call re-opens, re-authorizes and closes
 * all of its own services. Never invokes a publisher or any editorial release.
 */
export function readBoundedFeedSchedule(
  env: NodeJS.ProcessEnv,
  mode: FeedRuntimeMode = "single_pass",
): BoundedFeedSchedule {
  // Re-use ALL runtime identity, host, rights, anchor and queue gates before
  // reading any secret, opening Redis or starting the timer.
  readFeedRuntimeAdmission(env, mode);
  if (
    env.VNS_FEED_SCHEDULER_ENABLED !== "true" ||
    env.VNS_FEED_SCHEDULER_OPERATOR_ACK !== "true" ||
    env.VNS_FEED_SCHEDULER_MODE !== "bounded" ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false"
  ) {
    throw new Error("Bounded feed scheduling not authorized");
  }
  const ticks = env.VNS_FEED_SCHEDULER_MAX_TICKS ?? "";
  const failures = env.VNS_FEED_SCHEDULER_FAILURE_LIMIT ?? "";
  if (!/^[1-9][0-9]?$/.test(ticks) || !/^[1-3]$/.test(failures)) {
    throw new Error("Bounded feed scheduler limits invalid");
  }
  const maxTicks = Number(ticks);
  const failureLimit = Number(failures);
  if (maxTicks > MAX_TICKS || failureLimit > MAX_CONSECUTIVE_FAILURES) {
    throw new Error("Bounded feed scheduler limits invalid");
  }
  return Object.freeze({ maxTicks, failureLimit });
}

function clockMillis(ports: BoundedFeedSchedulePorts): number {
  const instant = ports.now();
  const millis = instant instanceof Date ? instant.getTime() : NaN;
  if (!Number.isSafeInteger(millis) || millis < 0) {
    throw new Error("Feed scheduler clock invalid");
  }
  return millis;
}

/** No missed slots are replayed; persisted BullMQ job IDs remain per-slot. */
export async function runBoundedFeedSchedule(
  env: NodeJS.ProcessEnv,
  ports: BoundedFeedSchedulePorts,
  signal: AbortSignal,
  mode: FeedRuntimeMode = "single_pass",
): Promise<{ attempted: number; succeeded: number; failures: number }> {
  const configuration = readBoundedFeedSchedule(env, mode);
  if (
    !ports ||
    typeof ports.now !== "function" ||
    typeof ports.delay !== "function" ||
    typeof ports.observe !== "function" ||
    typeof ports.record !== "function" ||
    !signal
  ) {
    throw new Error("Bounded feed scheduler ports unavailable");
  }
  let attempted = 0;
  let succeeded = 0;
  let consecutiveFailures = 0;
  let lastSlot = -1;
  let startSlot = -1;
  while (!signal.aborted && attempted < configuration.maxTicks) {
    const now = clockMillis(ports);
    const slot = Math.floor(now / SLOT_MS);
    if (startSlot < 0) startSlot = slot;
    // The session can never run beyond its first 16 slots. Restarts require
    // another explicitly authorized operator-run session.
    if (slot - startSlot >= MAX_TICKS) break;
    const offset = now % SLOT_MS;
    if (slot <= lastSlot || offset >= START_WINDOW_MS) {
      const sleepFor = SLOT_MS - offset;
      try {
        await ports.delay(sleepFor, signal);
      } catch {
        if (!signal.aborted) throw new Error("Feed scheduler timer failed");
      }
      continue;
    }
    lastSlot = slot;
    attempted++;
    // observe() is the existing real one-shot path. Every slot validates
    // current signed source, DB grants, host policy and independent anchor.
    try {
      const summary = await ports.observe();
      if (
        !summary ||
        summary.ok !== true ||
        ![summary.sourcesExamined, summary.candidatesAdded, summary.notModified].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      ) {
        throw new Error("Invalid feed observation");
      }
      succeeded++;
      consecutiveFailures = 0;
      ports.record("tick_ok", { slot, attempts: attempted, consecutiveFailures });
    } catch {
      consecutiveFailures++;
      ports.record("tick_failed", { slot, attempts: attempted, consecutiveFailures });
      if (consecutiveFailures >= configuration.failureLimit) {
        ports.record("halted", { slot, attempts: attempted, consecutiveFailures });
        throw new Error("Feed scheduler stopped after repeated failures");
      }
    }
  }
  return { attempted, succeeded, failures: attempted - succeeded };
}
