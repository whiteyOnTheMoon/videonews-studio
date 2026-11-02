import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFeedProducerProgressGuard,
  FEED_PRODUCER_MAX_OPERATION_MS,
  FEED_PRODUCER_MAX_INSPECTION_AGE_MS,
} from "./feed-producer-progress-guard.js";
import { publishFeedConsumerHealth, checkFeedConsumerHealth } from "./feed-consumer-health.js";

test("cannot advertise ready until first completed real queue inspection", () => {
  let at = 1000;
  const records: Array<{ state: string; at: number }> = [];
  const guard = createFeedProducerProgressGuard(
    () => at,
    (state, timestamp) => records.push({ state, at: timestamp }),
  );
  assert.equal(guard.pulse(), true);
  guard.begin("inspect");
  at += 19_000;
  assert.equal(guard.pulse(), true);
  assert.deepEqual(records, []);
  guard.finish("inspect");
  assert.equal(guard.pulse(), true);
  assert.deepEqual(records, [{ state: "ready", at }]);
  guard.begin("enqueue");
  at += 1000;
  guard.finish("enqueue");
  guard.stop();
  assert.equal(guard.pulse(), false);
  assert.equal(records.at(-1)?.state, "stopped");
  guard.stop();
  assert.equal(records.filter((record) => record.state === "stopped").length, 1);
});

test("hung Redis inspection or enqueue stops heartbeat after bounded time", () => {
  for (const kind of ["inspect", "enqueue"] as const) {
    let at = 1000;
    const records: string[] = [];
    const guard = createFeedProducerProgressGuard(
      () => at,
      (state) => records.push(state),
    );
    if (kind === "enqueue") {
      guard.begin("inspect");
      guard.finish("inspect");
    }
    guard.begin(kind);
    at += FEED_PRODUCER_MAX_OPERATION_MS - 1;
    assert.equal(guard.pulse(), true);
    at++;
    assert.equal(guard.pulse(), false);
    assert.equal(guard.stopped, true);
    assert.equal(records.at(-1), "stopped");
    assert.throws(() => guard.finish(kind));
    assert.throws(() => guard.begin("inspect"));
    guard.stop();
    assert.equal(records.filter((value) => value === "stopped").length, 1);
  }
});

test("idle 30-second scheduling sleeps are healthy; stale queue observations are not", () => {
  let at = 1000;
  const records: string[] = [];
  const guard = createFeedProducerProgressGuard(
    () => at,
    (state) => records.push(state),
  );
  guard.begin("inspect");
  guard.finish("inspect");
  at += 30_000;
  assert.equal(guard.pulse(), true);
  guard.begin("inspect");
  guard.finish("inspect");
  at += 30_000;
  assert.equal(guard.pulse(), true);
  at += FEED_PRODUCER_MAX_INSPECTION_AGE_MS - 30_000 - 1;
  assert.equal(guard.pulse(), true);
  at++;
  assert.equal(guard.pulse(), false);
  assert.equal(records.at(-1), "stopped");
});

test("an operation that returns after its timeout cannot restore ready", () => {
  let at = 10_000;
  const guard = createFeedProducerProgressGuard(
    () => at,
    () => undefined,
  );
  guard.begin("inspect");
  at += FEED_PRODUCER_MAX_OPERATION_MS;
  assert.throws(() => guard.finish("inspect"), /progress watchdog exceeded/);
  assert.equal(guard.stopped, true);
  assert.equal(guard.pulse(), false);
});

test("bounded enqueue failures do not falsely refresh successful inspection age", () => {
  let at = 100;
  const guard = createFeedProducerProgressGuard(
    () => at,
    () => undefined,
  );
  guard.begin("inspect");
  guard.finish("inspect");
  guard.begin("enqueue");
  at += 5000;
  guard.finish("enqueue", false);
  at += FEED_PRODUCER_MAX_INSPECTION_AGE_MS - 5000;
  assert.equal(guard.pulse(), false);
});

test("invalid monotonic clock or failed private heartbeat write fails closed", () => {
  let at = 15000;
  const guard = createFeedProducerProgressGuard(
    () => at,
    () => undefined,
  );
  guard.begin("inspect");
  guard.finish("inspect");
  at--;
  assert.equal(guard.pulse(), false);
  assert.equal(guard.stopped, true);
  const malformed = createFeedProducerProgressGuard(
    () => NaN,
    () => undefined,
  );
  assert.equal(malformed.pulse(), false);
  const failedWrite = createFeedProducerProgressGuard(
    () => 20000,
    () => {
      throw new Error("synthetic write failure");
    },
  );
  failedWrite.begin("inspect");
  failedWrite.finish("inspect");
  assert.equal(failedWrite.pulse(), false);
});

test("actual 0600 heartbeat becomes unhealthy immediately after operation watchdog trips", () => {
  const directory = mkdtempSync(join(tmpdir(), "vns-producer-progress-"));
  const path = join(directory, "heartbeat.json");
  let at = Date.now();
  const guard = createFeedProducerProgressGuard(
    () => at,
    (state, timestamp) =>
      publishFeedConsumerHealth(
        { version: 1, state, at: timestamp, pid: process.pid, consecutiveFailures: 0 },
        path,
      ),
  );
  try {
    assert.equal(
      checkFeedConsumerHealth(path, at, () => true),
      false,
    );
    guard.begin("inspect");
    guard.finish("inspect");
    assert.equal(guard.pulse(), true);
    assert.equal(
      checkFeedConsumerHealth(path, at, () => true),
      true,
    );
    guard.begin("enqueue");
    at += FEED_PRODUCER_MAX_OPERATION_MS;
    assert.equal(guard.pulse(), false);
    assert.equal(
      checkFeedConsumerHealth(path, at, () => true),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
