import { Redis } from "ioredis";
import { readFeedRuntimeAdmission, type FeedRuntimeMode } from "./feed-runtime-admission.js";
import { readFeedSecret } from "./feed-trusted-context.js";

/** Caller must first pass the dedicated side-effect-free role admission. */
export function openSeparatedFeedRedis(env: NodeJS.ProcessEnv, mode: FeedRuntimeMode): Redis {
  if (mode !== "bounded_producer" &&
    mode !== "continuous_producer" &&
    mode !== "persistent_worker") {
    throw new Error("Separated Redis runtime mode refused");
  }
  const admission = readFeedRuntimeAdmission(env, mode);
  const password = readFeedSecret(admission.redisSecretPath);
  const connection = new Redis({
    host: admission.redisHost,
    port: 6379,
    username: admission.redisUser,
    password,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  // Never print raw ioredis error text (can contain network details).
  connection.on("error", () => undefined);
  return connection;
}
