import { performance } from "node:perf_hooks";
import { publishFeedConsumerHealth } from "./feed-consumer-health.js";

/**
 * The consumer heartbeat reflects bounded, observed BullMQ work, not just
 * an event-loop timer. performance.now() measures job duration independently
 * of wall-clock/NTP changes; Docker still receives Date.now() timestamps.
 */
export function createFeedConsumerJobHealthGuard(
  maxJobMillis: number,
  clock: () => number = () => performance.now(),
  publish: (state: "ready" | "stopped", failures: number) => void = (state, failures) =>
    publishFeedConsumerHealth({
      version: 1,
      state,
      at: Date.now(),
      pid: process.pid,
      consecutiveFailures: failures,
    }),
) {
  if (!Number.isSafeInteger(maxJobMillis) || maxJobMillis < 30_000 || maxJobMillis > 600_000) {
    throw new Error("Feed consumer job bound refused");
  }

  let lastNow: number | null = null;
  let activeAt: number | null = null;
  let ready = false;
  let stopped = false;
  let failures = 0;

  const readClock = (): number => {
    const at = clock();
    if (!Number.isFinite(at) || at < 0 || (lastNow !== null && at < lastNow)) {
      throw new Error("Feed consumer monotonic clock refused");
    }
    lastNow = at;
    return at;
  };

  const stop = (): boolean => {
    if (stopped) return true;
    stopped = true;
    try {
      publish("stopped", failures);
      return true;
    } catch {
      // A failed 0600 status-file write is never converted into readiness.
      return false;
    }
  };

  const checkActive = (): boolean => {
    if (stopped) return false;
    try {
      const at = readClock();
      if (activeAt !== null && at - activeAt >= maxJobMillis) {
        stop();
        return false;
      }
      return true;
    } catch {
      stop();
      return false;
    }
  };

  return {
    get failures(): number {
      return failures;
    },
    get stopped(): boolean {
      return stopped;
    },
    ready(): boolean {
      if (stopped || ready) return false;
      ready = true;
      return this.pulse();
    },
    active(): boolean {
      if (!ready || stopped || activeAt !== null || !checkActive()) {
        stop();
        return false;
      }
      activeAt = lastNow;
      return true;
    },
    completed(): boolean {
      if (!ready || stopped || activeAt === null || !checkActive()) {
        stop();
        return false;
      }
      activeAt = null;
      failures = 0;
      // Persist job progress and reset counters immediately, not only on
      // the 20-second heartbeat interval.
      return this.pulse();
    },
    failed(): boolean {
      if (!ready || stopped || activeAt === null || !checkActive()) {
        stop();
        return false;
      }
      activeAt = null;
      failures++;
      if (failures >= 3) {
        stop();
        return false;
      }
      return this.pulse();
    },
    pulse(): boolean {
      if (!ready || !checkActive()) return false;
      try {
        publish("ready", failures);
        return true;
      } catch {
        stop();
        return false;
      }
    },
    stop,
  };
}
