import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { QUEUE_PREFIX } from "./queue.js";
import { PROVIDER_QUEUE } from "./provider-dedicated-queue.js";
import { dormantProviderOutboxPublisher } from "./provider-outbox-publisher.js";

const ROOT = "/run/secrets/vns";
const KEY_PATH = ROOT + "/provider-prompt-key";
const PG_PASSWORD = ROOT + "/provider-outbox-db-password";
const REDIS_PASSWORD = ROOT + "/provider-outbox-redis-password";
const ERROR = "Provider outbox runner unavailable";

function requireMode(env: NodeJS.ProcessEnv): string {
  if (
    env.VNS_PROVIDER_OUTBOX_PRODUCER_ENABLED !== "true" ||
    env.VNS_PROVIDER_OUTBOX_OPERATOR_ACK !== "true" ||
    env.VNS_PROVIDER_OUTBOX_QUEUE_NAME !== PROVIDER_QUEUE ||
    env.VNS_PROVIDER_OUTBOX_PG_USER !== "vns_provider_outbox_login" ||
    env.VNS_PROVIDER_OUTBOX_REDIS_USER !== "vns_provider_producer" ||
    env.VNS_PROVIDER_OUTBOX_KEY_FILE !== KEY_PATH ||
    env.VNS_PROVIDER_OUTBOX_PG_PASSWORD_FILE !== PG_PASSWORD ||
    env.VNS_PROVIDER_OUTBOX_REDIS_PASSWORD_FILE !== REDIS_PASSWORD ||
    env.VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED === "true" ||
    env.VNS_P1_PROVIDER_CANARY_ENABLED === "true"
  ) {
    throw new Error("Provider outbox runner disabled");
  }
  const database = env.VNS_PROVIDER_OUTBOX_DB_NAME ?? "videonews";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error(ERROR);
  return database;
}

function privateOwner(s: { uid: number; mode: number }): boolean {
  return process.getuid?.() === s.uid && (s.mode & 0o077) === 0;
}

async function withSecret<T>(
  path: string,
  length: number | null,
  operation: (value: Buffer) => Promise<T>,
): Promise<T> {
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  let buffer: Buffer | undefined;
  try {
    const directory = await lstat(ROOT);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !privateOwner(directory)) {
      throw Error(ERROR);
    }
    descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await descriptor.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      !privateOwner(info) ||
      ((info.mode & 0o777) !== 0o400 && (info.mode & 0o777) !== 0o600) ||
      (length === null ? info.size < 40 || info.size > 257 : info.size !== length)
    ) {
      throw Error(ERROR);
    }
    buffer = await descriptor.readFile();
    if (buffer.length !== info.size) throw Error(ERROR);
    return await operation(buffer);
  } catch {
    throw new Error(ERROR);
  } finally {
    buffer?.fill(0);
    await descriptor?.close().catch(() => undefined);
  }
}

async function password(path: string): Promise<string> {
  return withSecret(path, null, async (raw) => {
    const secret = raw.toString("ascii").trimEnd();
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(secret)) throw Error(ERROR);
    return secret;
  });
}

/** Separate one-shot producer. Nothing is opened before the operator gate. */
export async function runProviderOutboxOnce(env: NodeJS.ProcessEnv = process.env) {
  const database = requireMode(env);
  const [pgPassword, redisPassword] = await Promise.all([
    password(PG_PASSWORD),
    password(REDIS_PASSWORD),
  ]);
  const db = new Pool({
    host: "postgres",
    port: 5432,
    database,
    user: "vns_provider_outbox_login",
    password: pgPassword,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 3000,
    ssl: false,
  });
  const redis = new Redis({
    host: "redis",
    port: 6379,
    username: "vns_provider_producer",
    password: redisPassword,
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  const queue = new Queue(PROVIDER_QUEUE, { prefix: QUEUE_PREFIX, connection: redis });
  try {
    await queue.waitUntilReady();
    return await withSecret(KEY_PATH, 32, async (key) => {
      const producer = dormantProviderOutboxPublisher(db, queue, async (operation) => operation(key), true);
      return producer.runOnce(5);
    });
  } catch {
    throw new Error(ERROR);
  } finally {
    await queue.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
    await db.end().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith("/provider-outbox-once.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--once") {
    console.error("Provider outbox runner requires --once");
    process.exitCode = 2;
  } else {
    try {
      const count = await runProviderOutboxOnce();
      console.info(JSON.stringify({ event: "provider_outbox_once", ...count }));
    } catch {
      console.error("Provider outbox runner unavailable");
      process.exitCode = 1;
    }
  }
}
