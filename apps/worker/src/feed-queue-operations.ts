import { createSeparatedFeedProducer } from "./feed-bullmq-separated.js";
import { openSeparatedFeedRedis } from "./feed-separated-redis.js";
import { inspectFeedQueue } from "./feed-queue-inspection.js";
import {
  readContinuousFeedPolicy,
  validateFeedQueueSnapshot,
} from "./feed-scheduler-continuous.js";

/**
 * Read-only operator incident inventory. No SQL, source URLs, job payloads,
 * BullMQ error causes or job mutation. Failed jobs are deliberately retained
 * for explicit, authenticated human triage; no automatic retry/requeue.
 */
export async function inspectContinuousFeedOperations(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ healthy: boolean; failed: number; pending: number; failedJobIds: readonly string[] }> {
  const policy = readContinuousFeedPolicy(env);
  const redis = openSeparatedFeedRedis(env, "continuous_producer");
  let client: ReturnType<typeof createSeparatedFeedProducer> | undefined;
  try {
    client = createSeparatedFeedProducer(env, redis, "continuous_producer");
    await client.queue.waitUntilReady();
    const snapshot = await inspectFeedQueue(client.queue);
    let healthy = true;
    try {
      validateFeedQueueSnapshot(snapshot, policy, Date.now());
    } catch {
      healthy = false;
    }
    const jobs = await client.queue.getJobs(["failed"], 0, 49);
    const failedJobIds = jobs.map((job) => {
      const id = job.id;
      return typeof id === "string" && /^vns-feed-tick-[0-9]{4,20}$/.test(id)
        ? id
        : "untrusted-job-id";
    });
    return {
      healthy,
      failed: snapshot.failed,
      pending: snapshot.waiting + snapshot.active + snapshot.delayed + snapshot.paused,
      failedJobIds,
    };
  } catch {
    throw new Error("Feed operational inventory unavailable");
  } finally {
    await client?.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

if (process.argv[1]?.endsWith("/feed-queue-operations.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--inspect") {
    console.error("Feed queue inventory requires --inspect");
    process.exitCode = 2;
  } else {
    try {
      const report = await inspectContinuousFeedOperations();
      console.info(JSON.stringify({ event: "feed_queue_operations", ...report }));
      if (!report.healthy) process.exitCode = 1;
    } catch {
      console.error("Feed queue inventory unavailable");
      process.exitCode = 1;
    }
  }
}
