import { setTimeout as delay } from "node:timers/promises";
import { createSeparatedFeedProducer, requireSeparatedFeedGate } from "./feed-bullmq-separated.js";
import { openSeparatedFeedRedis } from "./feed-separated-redis.js";
import { inspectFeedQueue } from "./feed-queue-inspection.js";
import {
  runContinuousFeedSchedule,
  readContinuousFeedPolicy,
} from "./feed-scheduler-continuous.js";
import { publishFeedConsumerHealth } from "./feed-consumer-health.js";

export const FEED_PRODUCER_HEALTH_PATH = "/tmp/vns-feed-producer-health.json";

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
  const unhealthy = () => {
    connectionFailed = true;
    controller.abort();
  };
  redis.on("error", unhealthy);
  const pulse = (state: "ready" | "stopped") =>
    publishFeedConsumerHealth(
      { version: 1, state, at: Date.now(), pid: process.pid, consecutiveFailures: 0 },
      FEED_PRODUCER_HEALTH_PATH,
    );
  try {
    producer = createSeparatedFeedProducer(env, redis, "continuous_producer");
    await producer.queue.waitUntilReady();
    pulse("ready");
    heartbeat = setInterval(() => {
      try {
        pulse("ready");
      } catch {
        unhealthy();
      }
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
        inspect: () => inspectFeedQueue(producer!.queue),
        enqueue: (at) => producer!.enqueue(at),
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
      pulse("stopped");
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
