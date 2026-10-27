import { createSeparatedFeedConsumer, requireSeparatedFeedGate } from "./feed-bullmq-separated.js";
import { openSeparatedFeedRedis } from "./feed-separated-redis.js";
import { openTrustedFeedContext } from "./feed-trusted-context.js";

/**
 * Long-lived consumer with no internal scheduling or producer connection.
 * Each delivery must independently verify its signed sources and DB roles.
 * Stops on Redis/worker errors or repeated failures rather than silently
 * running in a potentially degraded state.
 */
export async function runPersistentFeedWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireSeparatedFeedGate(env, "consumer");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const redis = openSeparatedFeedRedis(env, "persistent_worker");
  let consumer: ReturnType<typeof createSeparatedFeedConsumer> | undefined;
  try {
    let consecutiveFailures = 0;
    consumer = createSeparatedFeedConsumer(
      env,
      redis,
      () => openTrustedFeedContext(env, "persistent_worker"),
    );
    consumer.worker.on("completed", () => {
      consecutiveFailures = 0;
      console.info(JSON.stringify({ event: "feed_consumer_job_completed" }));
    });
    consumer.worker.on("failed", () => {
      consecutiveFailures++;
      console.error(JSON.stringify({ event: "feed_consumer_job_failed", consecutiveFailures }));
      if (consecutiveFailures >= 3) controller.abort();
    });
    consumer.worker.on("stalled", () => {
      console.error(JSON.stringify({ event: "feed_consumer_job_stalled" }));
    });
    consumer.worker.on("error", stop);
    redis.on("error", stop);
    await consumer.worker.waitUntilReady();
    console.info(JSON.stringify({ event: "feed_consumer_ready" }));
    if (!controller.signal.aborted) {
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (consecutiveFailures >= 3) {
      throw new Error("Repeated feed consumer failures");
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await consumer?.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

if (process.argv[1]?.endsWith("/feed-worker-persistent.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--persistent-worker") {
    console.error("Feed consumer requires --persistent-worker");
    process.exitCode = 2;
  } else {
    try {
      await runPersistentFeedWorker();
      console.info(JSON.stringify({ event: "feed_consumer_stopped" }));
    } catch {
      console.error("Persistent feed consumer halted");
      process.exitCode = 1;
    }
  }
}
