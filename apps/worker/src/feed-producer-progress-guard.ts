import { publishFeedConsumerHealth } from "./feed-consumer-health.js";
import { FEED_PRODUCER_HEALTH_PATH } from "./feed-producer-health-path.js";

/** Each Redis inspection/enqueue must complete; the 30s idle sleep is normal. */
export const FEED_PRODUCER_MAX_OPERATION_MS = 60_000;
export const FEED_PRODUCER_MAX_INSPECTION_AGE_MS = 75_000;

export type FeedProducerQueueOperation = "inspect" | "enqueue";

/**
 * No queue access is allowed to be reported as healthy before the first
 * successful queue inspection. A Node timer can run while awaited Redis
 * requests remain pending, so heartbeat age alone is not a progress signal.
 */
export function createFeedProducerProgressGuard(
  now: () => number = Date.now,
  publish: (state: "ready" | "stopped", at: number) => void = (state, at) =>
    publishFeedConsumerHealth(
      { version: 1, state, at, pid: process.pid, consecutiveFailures: 0 },
      FEED_PRODUCER_HEALTH_PATH,
    ),
) {
  let lastTime: number | null = null;
  let initializedAt: number | null = null;
  let lastInspectedAt: number | null = null;
  let operation: FeedProducerQueueOperation | null = null;
  let operationAt: number | null = null;
  let stopped = false;

  const readClock = (): number => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || (lastTime !== null && value < lastTime)) {
      throw new Error("Feed producer progress clock refused");
    }
    lastTime = value;
    if (initializedAt === null) initializedAt = value;
    return value;
  };

  const stopAt = (at: number): void => {
    if (stopped) return;
    stopped = true;
    publish("stopped", at);
  };

  const requireProgress = (at: number): void => {
    if (
      (operationAt !== null && at - operationAt >= FEED_PRODUCER_MAX_OPERATION_MS) ||
      (initializedAt !== null &&
        at - (lastInspectedAt ?? initializedAt) >= FEED_PRODUCER_MAX_INSPECTION_AGE_MS)
    ) {
      stopAt(at);
      throw new Error("Feed producer queue progress watchdog exceeded");
    }
  };

  return {
    begin(next: FeedProducerQueueOperation): void {
      if (stopped || operation !== null || (next !== "inspect" && next !== "enqueue")) {
        throw new Error("Feed producer queue operation refused");
      }
      const at = readClock();
      requireProgress(at);
      operation = next;
      operationAt = at;
    },

    finish(expected: FeedProducerQueueOperation, success = true): void {
      if (stopped || operation !== expected || operationAt === null) {
        throw new Error("Feed producer queue operation state refused");
      }
      const at = readClock();
      requireProgress(at);
      if (success && expected === "inspect") lastInspectedAt = at;
      operation = null;
      operationAt = null;
    },

    pulse(): boolean {
      if (stopped) return false;
      try {
        const at = readClock();
        requireProgress(at);
        // No initial ready pulse before a successful real queue inspection.
        if (lastInspectedAt !== null) publish("ready", at);
        return true;
      } catch {
        stopped = true;
        return false;
      }
    },

    stop(): void {
      if (stopped) return;
      try {
        stopAt(readClock());
      } catch {
        stopped = true;
        throw new Error("Feed producer progress heartbeat unavailable");
      }
    },

    get stopped(): boolean {
      return stopped;
    },
  };
}
