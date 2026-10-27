import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkFeedConsumerHealth,
  publishFeedConsumerHealth,
  FEED_CONSUMER_MAX_HEARTBEAT_AGE_MS,
  type FeedConsumerHealthRecord,
} from "./feed-consumer-health.js";

function fixture(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "vns-feed-health-"));
  try {
    run(join(dir, "health.json"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

const record: FeedConsumerHealthRecord = {
  version: 1,
  state: "ready",
  at: 10000,
  pid: process.pid,
  consecutiveFailures: 0,
};

test("private, atomic heartbeat reports real process readiness and failure counters", () => {
  fixture((path) => {
    assert.equal(checkFeedConsumerHealth(path, record.at, () => true), false);
    publishFeedConsumerHealth(record, path);
    assert.equal(checkFeedConsumerHealth(path, record.at, (pid) => pid === process.pid), true);
    assert.equal(checkFeedConsumerHealth(path, record.at, () => false), false);
    publishFeedConsumerHealth({ ...record, consecutiveFailures: 2 }, path);
    assert.equal(checkFeedConsumerHealth(path, record.at, () => true), true);
    publishFeedConsumerHealth({ ...record, state: "stopped" }, path);
    assert.equal(checkFeedConsumerHealth(path, record.at, () => true), false);
  });
});

test("stale/future health never reports healthy", () => {
  fixture((path) => {
    publishFeedConsumerHealth(record, path);
    assert.equal(
      checkFeedConsumerHealth(path, record.at + FEED_CONSUMER_MAX_HEARTBEAT_AGE_MS, () => true),
      true,
    );
    assert.equal(
      checkFeedConsumerHealth(path, record.at + FEED_CONSUMER_MAX_HEARTBEAT_AGE_MS + 1, () => true),
      false,
    );
    assert.equal(checkFeedConsumerHealth(path, record.at - 1, () => true), false);
    assert.equal(checkFeedConsumerHealth(path, -1, () => true), false);
  });
});

test("refuses symlinks, insecure permissions, hardlinks and malformed files", () => {
  fixture((path) => {
    const alias = path + ".alias";
    publishFeedConsumerHealth(record, path);
    symlinkSync(path, alias);
    assert.equal(checkFeedConsumerHealth(alias, record.at, () => true), false);
    rmSync(alias);
    linkSync(path, alias);
    assert.equal(checkFeedConsumerHealth(path, record.at, () => true), false);
    rmSync(alias);
    chmodSync(path, 0o666);
    assert.equal(checkFeedConsumerHealth(path, record.at, () => true), false);
    writeFileSync(path, '{"version":1,"state":"ready"}', { mode: 0o600 });
    chmodSync(path, 0o600);
    assert.equal(checkFeedConsumerHealth(path, record.at, () => true), false);
  });
});

test("invalid writer records and path traversal are rejected before any file mutation", () => {
  fixture((path) => {
    for (const candidate of [
      { ...record, state: "publishing" },
      { ...record, consecutiveFailures: 4 },
      { ...record, pid: -1 },
      { ...record, at: NaN },
      { ...record, unsupported: "yes" },
    ]) {
      assert.throws(() =>
        publishFeedConsumerHealth(candidate as FeedConsumerHealthRecord, path),
      );
    }
    assert.throws(() => publishFeedConsumerHealth(record, "/tmp/../run/secrets/pwn"));
    assert.equal(
      checkFeedConsumerHealth("/tmp/../run/secrets/pwn", record.at, () => true),
      false,
    );
    assert.equal(checkFeedConsumerHealth(path, record.at, () => true), false);
  });
});
