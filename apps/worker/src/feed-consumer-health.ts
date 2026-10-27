import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export const FEED_CONSUMER_HEALTH_PATH = "/tmp/vns-feed-consumer-health.json" as const;
export const FEED_CONSUMER_MAX_HEARTBEAT_AGE_MS = 90_000 as const;

export interface FeedConsumerHealthRecord {
  version: 1;
  state: "ready" | "stopped";
  at: number;
  pid: number;
  consecutiveFailures: number;
}

function validRecord(value: unknown): value is FeedConsumerHealthRecord {
  if (typeof value !== "object" || !value || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "at,consecutiveFailures,pid,state,version" &&
    record.version === 1 &&
    (record.state === "ready" || record.state === "stopped") &&
    Number.isSafeInteger(record.at) &&
    (record.at as number) >= 0 &&
    Number.isSafeInteger(record.pid) &&
    (record.pid as number) > 0 &&
    Number.isSafeInteger(record.consecutiveFailures) &&
    (record.consecutiveFailures as number) >= 0 &&
    (record.consecutiveFailures as number) <= 3
  );
}

/** Atomic, private, minimal operational status in the container's tmpfs. */
export function publishFeedConsumerHealth(
  record: FeedConsumerHealthRecord,
  path: string = FEED_CONSUMER_HEALTH_PATH,
): void {
  if (!validRecord(record) || !path.startsWith("/tmp/")) {
    throw new Error("Feed consumer heartbeat refused");
  }
  const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // An absent ephemeral file needs no cleanup.
    }
    throw new Error("Feed consumer heartbeat unavailable");
  }
}

/** Strict read-only healthcheck: never trust a stale, symlinked or writable file. */
export function checkFeedConsumerHealth(
  path: string = FEED_CONSUMER_HEALTH_PATH,
  now: number = Date.now(),
  isAlive: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
): boolean {
  if (!path.startsWith("/tmp/") || !Number.isSafeInteger(now) || now < 0) return false;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 20 || stat.size > 512) return false;
    if ((stat.mode & 0o077) !== 0) return false;
    const data: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!validRecord(data) || data.state !== "ready") return false;
    if (data.at > now || now - data.at > FEED_CONSUMER_MAX_HEARTBEAT_AGE_MS) return false;
    return isAlive(data.pid);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
