import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { QueueEvents } from "bullmq";
import { readFeedRuntimeAdmission, attestFeedDatabaseIdentity } from "./feed-runtime-admission.js";
import { createDormantFeedScheduler } from "./feed-scheduler-composition.js";
import { createGatedFeedBullmqBridge, ISOLATED_FEED_REDIS_PREFIX } from "./feed-bullmq-bridge.js";
import { ISOLATED_FEED_QUEUE } from "./feed-queue-contract.js";
import { productionFeedHttpsDependencies } from "./feed-https-transport.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "./research-service-config.js";

function secret(path: string): string {
  try {
    const password = readFileSync(path, "utf8").trimEnd();
    if (password.length < 40 || password.length > 256 || !/^[A-Za-z0-9_-]+$/.test(password)) {
      throw new Error("invalid password");
    }
    return password;
  } catch {
    throw new Error("Feed runtime secret unavailable");
  }
}

export interface FeedObservationSummary {
  ok: true;
  sourcesExamined: number;
  candidatesAdded: number;
  notModified: number;
}

/**
 * One expressly authorized CI-rehearsable observation. No cron, repeat jobs,
 * migrations, source discovery or publication. Does not reuse probe/research
 * workers, database roles or queues. Real sources require prior rights review.
 */
export async function observeFeedOnce(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeedObservationSummary> {
  // Zero side effects before fully validating every non-secret gate.
  const admission = readFeedRuntimeAdmission(env);
  const pgPassword = secret(admission.dbSecretPath);
  const redisPassword = secret(admission.redisSecretPath);

  const pool = new Pool({
    host: admission.dbHost,
    port: 5432,
    database: "videonews",
    user: admission.dbUser,
    password: pgPassword,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    application_name: "vns_feed_observation",
  });
  let producer: Redis | undefined;
  let consumer: Redis | undefined;
  let eventsConnection: Redis | undefined;
  let queueEvents: QueueEvents | undefined;
  let bridge: ReturnType<typeof createGatedFeedBullmqBridge> | undefined;
  try {
    // Do not read a source file or create Redis connections until PostgreSQL
    // has proved the actual authenticated session_user has narrow permissions.
    await attestFeedDatabaseIdentity(pool, admission.dbUser);
    const scheduler = createDormantFeedScheduler(env, {
      pool,
      https: productionFeedHttpsDependencies(),
      readRegistry(path) {
        if (path !== REVIEWED_SOURCE_REGISTRY_PATH) {
          throw new Error("Unexpected source registry");
        }
        return readFileSync(path, "utf8");
      },
    });

    const redisConfig = {
      host: admission.redisHost,
      port: 6379,
      username: admission.redisUser,
      password: redisPassword,
      enableReadyCheck: true,
      maxRetriesPerRequest: null,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy: () => null,
    };
    producer = new Redis(redisConfig);
    consumer = new Redis(redisConfig);
    // QueueEvents performs blocking Redis reads. Never multiplex that connection
    // with the producer: dedicated ownership makes shutdown and ACLs predictable.
    eventsConnection = new Redis(redisConfig);
    // A worker Redis failure must be an application failure, not an unhandled
    // error which prints connection/credential details to logs.
    producer.on("error", () => undefined);
    consumer.on("error", () => undefined);
    eventsConnection.on("error", () => undefined);
    bridge = createGatedFeedBullmqBridge(env, scheduler, {
      producer,
      consumer,
      now: () => new Date(),
    });
    bridge.worker.on("error", () => undefined);
    queueEvents = new QueueEvents(ISOLATED_FEED_QUEUE, {
      connection: eventsConnection,
      prefix: ISOLATED_FEED_REDIS_PREFIX,
    });
    queueEvents.on("error", () => undefined);
    await Promise.all([bridge.worker.waitUntilReady(), queueEvents.waitUntilReady()]);
    const id = await bridge.enqueue(new Date());
    const job = await bridge.queue.getJob(id);
    if (!job) throw new Error("No feed observation job");
    const result: unknown = await job.waitUntilFinished(queueEvents, 45000);
    if (
      !result ||
      typeof result !== "object" ||
      !("ok" in result) ||
      result.ok !== true ||
      !("sourcesExamined" in result) ||
      !("candidatesAdded" in result) ||
      !("notModified" in result) ||
      ![result.sourcesExamined, result.candidatesAdded, result.notModified].every(
        (value) => Number.isSafeInteger(value) && (value as number) >= 0,
      )
    ) {
      throw new Error("Feed observation result invalid");
    }
    return {
      ok: true,
      sourcesExamined: result.sourcesExamined as number,
      candidatesAdded: result.candidatesAdded as number,
      notModified: result.notModified as number,
    };
  } catch {
    throw new Error("Feed observation unavailable");
  } finally {
    await queueEvents?.close().catch(() => undefined);
    await bridge?.close().catch(() => undefined);
    await consumer?.quit().catch(() => consumer?.disconnect());
    await eventsConnection?.quit().catch(() => eventsConnection?.disconnect());
    await producer?.quit().catch(() => producer?.disconnect());
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith("/feed-observe-once.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--once") {
    console.error("Feed observation requires the explicit --once argument");
    process.exitCode = 2;
  } else {
    try {
      const summary = await observeFeedOnce();
      // Operationally useful aggregate count only. No source URLs, SQL or secrets.
      console.log(JSON.stringify({ event: "feed_observation_complete", ...summary }));
    } catch {
      console.error("Feed observation refused or failed (details omitted)");
      process.exitCode = 1;
    }
  }
}
