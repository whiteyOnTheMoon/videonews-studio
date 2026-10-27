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
    const waiting = counts.waiting ?? 0;
    const active = counts.active ?? 0;
    const delayed = counts.delayed ?? 0;
    const failed = counts.failed ?? 0;
    const completed = counts.completed ?? 0;
    // BullMQ v6 exposes pause as a queue-level state, not a JobType.
    const paused = 0;
    const pending = waiting + active + delayed + paused;
    const queuePaused = await queue.isPaused();
    let oldestPendingAt: number | null = null;
    if (pending > 0 && pending <= 20) {
      const jobs = await queue.getJobs(["waiting", "active", "delayed"], 0, 20);
      if (!Array.isArray(jobs) || jobs.length === 0) {
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
