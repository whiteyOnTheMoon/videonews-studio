import type { Queue } from "bullmq";
import type { FeedQueueSnapshot } from "./feed-scheduler-continuous.js";

type InspectionPort = Pick<Queue, "getJobCounts" | "getJobs" | "isPaused">;

/** Only bounded counts and timestamps. Never read or log job payloads/errors. */
export async function inspectFeedQueue(queue: InspectionPort): Promise<FeedQueueSnapshot> {
  if (
    !queue ||
    typeof queue.getJobCounts !== "function" ||
    typeof queue.getJobs !== "function" ||
    typeof queue.isPaused !== "function"
  ) {
    throw new Error("Feed queue inspection port invalid");
  }
  try {
    const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed");
    // Missing or malformed counters must never be interpreted as an empty
    // queue: in particular an absent failed count must not admit new jobs.
    const requireCount = (value: unknown): number => {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 1_000_000
      ) {
        throw new Error("Invalid feed queue counters");
      }
      return value;
    };
    const waiting = requireCount(counts?.waiting);
    const active = requireCount(counts?.active);
    const delayed = requireCount(counts?.delayed);
    const failed = requireCount(counts?.failed);
    const completed = requireCount(counts?.completed);
    // BullMQ v6 exposes pause as a queue-level state, not a JobType.
    const paused = 0;
    const pending = waiting + active + delayed + paused;
    const queuePaused = await queue.isPaused();
    let oldestPendingAt: number | null = null;
    if (pending > 0 && pending <= 20) {
      const jobs = await queue.getJobs(["waiting", "active", "delayed"], 0, 20);
      // A partial list can conceal an older, already stale pending job.
      // Count/list races are deliberately treated as unhealthy and retried
      // only after operator inspection, not as a healthy queue snapshot.
      if (!Array.isArray(jobs) || jobs.length !== pending) {
        throw new Error("Inconsistent feed queue snapshot");
      }
      const timestamps = jobs.map((job) => job.timestamp);
      if (timestamps.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error("Invalid feed job timestamp");
      }
      oldestPendingAt = Math.min(...timestamps);
    }
    return { waiting, active, delayed, failed, completed, paused, queuePaused, oldestPendingAt };
  } catch {
    throw new Error("Feed queue inspection unavailable");
  }
}
