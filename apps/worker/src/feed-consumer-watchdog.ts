import { requireSeparatedFeedGate } from "./feed-bullmq-separated.js";

export function readFeedConsumerWatchdogSeconds(env: NodeJS.ProcessEnv): number {
  requireSeparatedFeedGate(env, "consumer");
  const value = env.VNS_FEED_CONSUMER_MAX_JOB_SECONDS ?? "";
  if (!/^[1-9][0-9]{1,2}$/.test(value)) {
    throw new Error("Feed consumer watchdog not configured");
  }
  const seconds = Number(value);
  if (seconds < 30 || seconds > 600) {
    throw new Error("Feed consumer watchdog limit refused");
  }
  return seconds;
}
