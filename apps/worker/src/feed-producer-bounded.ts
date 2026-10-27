import { setTimeout as delay } from "node:timers/promises";
import { runBoundedFeedSchedule } from "./bounded-feed-scheduler.js";
import { createSeparatedFeedProducer, requireSeparatedFeedGate } from "./feed-bullmq-separated.js";
import { openSeparatedFeedRedis } from "./feed-separated-redis.js";

/**
 * Deliberately bounded producer process. Each slot is durably queued and
 * processed by a DIFFERENT persistent worker. No feed fetch or DB access.
 */
export async function runSeparatedFeedProducer(env: NodeJS.ProcessEnv = process.env) {
  requireSeparatedFeedGate(env, "producer");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const redis = openSeparatedFeedRedis(env, "bounded_producer");
  let producer: ReturnType<typeof createSeparatedFeedProducer> | undefined;
  try {
    producer = createSeparatedFeedProducer(env, redis);
    await producer.queue.waitUntilReady();
    return await runBoundedFeedSchedule(
      env,
      {
        now: () => new Date(),
        async delay(ms, signal) {
          await delay(ms, undefined, { signal });
        },
        async observe() {
          await producer!.enqueue(new Date());
          // These are enqueue metrics ONLY; processing outcomes belong to worker.
          return { ok: true, sourcesExamined: 0, candidatesAdded: 0, notModified: 0 };
        },
        record(event, fields) {
          const name = event === "tick_ok" ? "enqueued" : event;
          const log = JSON.stringify({ event: "feed_producer_" + name, ...fields });
          if (event === "tick_ok") console.info(log);
          else console.error(log);
        },
      },
      controller.signal,
      "bounded_producer",
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await producer?.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

if (process.argv[1]?.endsWith("/feed-producer-bounded.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--bounded-producer") {
    console.error("Feed producer requires --bounded-producer");
    process.exitCode = 2;
  } else {
    try {
      const summary = await runSeparatedFeedProducer();
      console.info(JSON.stringify({ event: "feed_producer_finished", ...summary }));
      if (summary.failures) process.exitCode = 1;
    } catch {
      console.error("Separated feed producer halted");
      process.exitCode = 1;
    }
  }
}
