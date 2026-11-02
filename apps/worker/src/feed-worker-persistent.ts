import { createSeparatedFeedConsumer, requireSeparatedFeedGate } from "./feed-bullmq-separated.js";
import { openSeparatedFeedRedis } from "./feed-separated-redis.js";
import { openTrustedFeedContext } from "./feed-trusted-context.js";
import { createFeedConsumerJobHealthGuard } from "./feed-consumer-job-health-guard.js";
import { readFeedConsumerWatchdogSeconds } from "./feed-consumer-watchdog.js";

/**
 * Long-lived consumer with no internal scheduling or producer connection.
 * Each delivery must independently verify its signed sources and DB roles.
 * Stops on Redis/worker errors or repeated failures rather than silently
 * running in a potentially degraded state.
 */
export async function runPersistentFeedWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireSeparatedFeedGate(env, "consumer");
  const maxJobMillis = readFeedConsumerWatchdogSeconds(env) * 1000;
  const controller = new AbortController();
  const health = createFeedConsumerJobHealthGuard(maxJobMillis);
  const stop = () => {
    if (!health.stop()) process.exitCode = 1;
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const redis = openSeparatedFeedRedis(env, "persistent_worker");
  let consumer: ReturnType<typeof createSeparatedFeedConsumer> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unexpectedConnectionFailure = false;
  const failClosed = () => {
    unexpectedConnectionFailure = true;
    stop();
  };
  try {
    consumer = createSeparatedFeedConsumer(env, redis, () =>
      openTrustedFeedContext(env, "persistent_worker"),
    );
    consumer.worker.on("active", () => {
      if (!health.active()) {
        console.error(JSON.stringify({ event: "feed_consumer_invalid_job_transition" }));
        failClosed();
      }
    });
    consumer.worker.on("completed", () => {
      if (!health.completed()) {
        console.error(JSON.stringify({ event: "feed_consumer_job_watchdog_halted" }));
        failClosed();
        return;
      }
      console.info(JSON.stringify({ event: "feed_consumer_job_completed" }));
    });
    consumer.worker.on("failed", () => {
      const accepted = health.failed();
      console.error(
        JSON.stringify({
          event: "feed_consumer_job_failed",
          consecutiveFailures: health.failures,
        }),
      );
      if (!accepted) failClosed();
    });
    consumer.worker.on("stalled", () => {
      console.error(JSON.stringify({ event: "feed_consumer_job_stalled" }));
      failClosed();
    });
    consumer.worker.on("error", failClosed);
    redis.on("error", failClosed);
    await consumer.worker.waitUntilReady();
    if (!health.ready()) throw new Error("Feed consumer readiness health gate refused");
    heartbeat = setInterval(() => {
      if (!health.pulse()) {
        console.error(JSON.stringify({ event: "feed_consumer_job_watchdog_halted" }));
        failClosed();
      }
    }, 20_000);
    heartbeat.unref();
    console.info(JSON.stringify({ event: "feed_consumer_ready" }));
    if (!controller.signal.aborted) {
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (unexpectedConnectionFailure) {
      throw new Error("Feed consumer stopped after failed health gate");
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (!health.stop()) process.exitCode = 1;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await consumer
      ?.close(unexpectedConnectionFailure || health.failures >= 3)
      .catch(() => undefined);
    if (unexpectedConnectionFailure) redis.disconnect();
    else await redis.quit().catch(() => redis.disconnect());
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
