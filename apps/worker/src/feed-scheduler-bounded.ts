import { setTimeout as delay } from "node:timers/promises";
import { observeFeedOnce } from "./feed-observe-once.js";
import { runBoundedFeedSchedule } from "./bounded-feed-scheduler.js";

export async function executeBoundedFeedSchedule(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ attempted: number; succeeded: number; failures: number }> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    return await runBoundedFeedSchedule(
      env,
      {
        now: () => new Date(),
        delay: async (ms, signal) => {
          await delay(ms, undefined, { signal });
        },
        observe: () => observeFeedOnce(env),
        record(event, fields) {
          // Deliberately no source URLs, credentials, SQL or raw thrown errors.
          const line = JSON.stringify({ event: "feed_scheduler_" + event, ...fields });
          if (event === "tick_ok") console.info(line);
          else console.error(line);
        },
      },
      controller.signal,
    );
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

if (process.argv[1]?.endsWith("/feed-scheduler-bounded.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--bounded") {
    console.error("Feed scheduler requires --bounded");
    process.exitCode = 2;
  } else {
    try {
      const summary = await executeBoundedFeedSchedule();
      console.info(JSON.stringify({ event: "feed_scheduler_completed", ...summary }));
      if (summary.failures) process.exitCode = 1;
    } catch {
      console.error("Feed scheduler unavailable or halted");
      process.exitCode = 1;
    }
  }
}
