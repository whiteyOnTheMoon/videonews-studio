import { publishFeedConsumerHealth } from "./feed-consumer-health.js";

export const FEED_PROJECTOR_HEALTH_PATH = "/tmp/vns-feed-projector-health.json";
export const FEED_PROJECTOR_MAX_SOURCE_MS = 60_000;

type Publish = (state: "ready" | "stopped", at: number) => void;

/**
 * A source projection that never returns must not look healthy merely
 * because the Node.js timer continues to run. The long approved pause
 * between cycles is healthy; only a single in-flight DB projection is
 * subject to the watchdog. No source IDs or DB details enter the status.
 */
export function createFeedProjectionHealthGuard(
  now: () => number = Date.now,
  publish: Publish = (state, at) =>
    publishFeedConsumerHealth(
      { version: 1, state, at, pid: process.pid, consecutiveFailures: 0 },
      FEED_PROJECTOR_HEALTH_PATH,
    ),
) {
  let started: number | null = null;
  let lastTime: number | null = null;
  let stopped = false;

  const readTime = (): number => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || (lastTime !== null && value < lastTime)) {
      throw new Error("Feed projector clock refused");
    }
    lastTime = value;
    return value;
  };
  const stop = (): void => {
    if (!stopped) {
      stopped = true;
      publish("stopped", readTime());
    }
  };
  return {
    pulse(): boolean {
      if (stopped) return false;
      try {
        const timestamp = readTime();
        if (started !== null && timestamp - started > FEED_PROJECTOR_MAX_SOURCE_MS) {
          stop();
          return false;
        }
        publish("ready", timestamp);
        return true;
      } catch {
        // A malformed clock or failed status-file write cannot be
        // converted into a healthy projector.
        stopped = true;
        return false;
      }
    },
    beginSource(): void {
      if (stopped || started !== null) throw new Error("Feed projector source state refused");
      started = readTime();
    },
    finishSource(): void {
      if (stopped || started === null) throw new Error("Feed projector source state refused");
      const timestamp = readTime();
      if (timestamp - started > FEED_PROJECTOR_MAX_SOURCE_MS) {
        stop();
        throw new Error("Feed projector source watchdog exceeded");
      }
      started = null;
    },
    stop,
  };
}
