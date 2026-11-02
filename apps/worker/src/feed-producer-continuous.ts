import { setTimeout as delay } from "node:timers/promises";
import { createSeparatedFeedProducer, requireSeparatedFeedGate } from "./feed-bullmq-separated.js";
import { openSeparatedFeedRedis } from "./feed-separated-redis.js";
import { inspectFeedQueue } from "./feed-queue-inspection.js";
import {
  runContinuousFeedSchedule,
  readContinuousFeedPolicy,
} from "./feed-scheduler-continuous.js";
import { createFeedProducerProgressGuard } from "./feed-producer-progress-guard.js";

export { FEED_PRODUCER_HEALTH_PATH } from "./feed-producer-health-path.js";

/**
 * Explicit opt-in continuous scheduler. Only BullMQ access is mounted.
 * Source rights, per-source intervals and DB revision are checked by
 * independent consumer on EACH delivery.
 */
export async function runContinuousFeedProducer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  requireSeparatedFeedGate(env, "producer", "continuous_producer");
  readContinuousFeedPolicy(env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const redis = openSeparatedFeedRedis(env, "continuous_producer");
  let producer: ReturnType<typeof createSeparatedFeedProducer> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let connectionFailed = false;
  const progress = createFeedProducerProgressGuard();
  const unhealthy = () => {
    connectionFailed = true;
    try {
      progress.stop();
    } catch {
      process.exitCode = 1;
    }
    controller.abort();
  };
  redis.on("error", unhealthy);
  try {
    producer = createSeparatedFeedProducer(env, redis, "continuous_producer");
    await producer.queue.waitUntilReady();
    // Heartbeat may only report ready AFTER the queue was inspected.
    // A stuck Redis request must not be concealed by this independent timer.
    heartbeat = setInterval(() => {
      if (!progress.pulse()) unhealthy();
    }, 20_000);
    heartbeat.unref();
    console.info(JSON.stringify({ event: "feed_continuous_producer_ready" }));
    await runContinuousFeedSchedule(
      env,
      {
        now: () => new Date(),
        async delay(ms, signal) {
          await delay(ms, undefined, { signal });
        },
        async inspect() {
          progress.begin("inspect");
          try {
            const snapshot = await inspectFeedQueue(producer!.queue);
            progress.finish("inspect");
            return snapshot;
          } catch {
            unhealthy();
            throw new Error("Feed queue inspection unavailable");
          }
        },
        async enqueue(at) {
          progress.begin("enqueue");
          try {
            const id = await producer!.enqueue(at);
            progress.finish("enqueue");
            return id;
          } catch {
            // Preserve the existing bounded enqueue-failure policy in the
            // scheduler. The progress watchdog remains authoritative.
            if (!progress.stopped) progress.finish("enqueue", false);
            throw new Error("Feed queue enqueue unavailable");
          }
        },
        record(event, fields) {
          const line = JSON.stringify({ event: "feed_continuous_" + event, ...fields });
          if (event === "slot_enqueued") console.info(line);
          else console.error(line);
        },
      },
      controller.signal,
    );
    if (connectionFailed) throw new Error("Feed Redis connection unavailable");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      progress.stop();
    } catch {
      process.exitCode = 1;
    }
    redis.off("error", unhealthy);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await producer?.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

if (process.argv[1]?.endsWith("/feed-producer-continuous.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--continuous") {
    console.error("Continuous feed producer requires --continuous");
    process.exitCode = 2;
  } else {
    try {
      await runContinuousFeedProducer();
      console.info(JSON.stringify({ event: "feed_continuous_producer_stopped" }));
    } catch {
      console.error("Continuous feed producer halted (details omitted)");
      process.exitCode = 1;
    }
  }
}
