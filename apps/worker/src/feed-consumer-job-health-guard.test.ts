import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFeedConsumerHealth, publishFeedConsumerHealth } from "./feed-consumer-health.js";
import { createFeedConsumerJobHealthGuard } from "./feed-consumer-job-health-guard.js";

test("consumer reports ready only after worker initialization and resets failures on success", () => {
  let elapsed = 1000;
  const states: string[] = [];
  const failures: number[] = [];
  const guard = createFeedConsumerJobHealthGuard(
    30_000,
    () => elapsed,
    (state, count) => {
      states.push(state);
      failures.push(count);
    },
  );
  assert.equal(guard.pulse(), false);
  assert.equal(guard.ready(), true);
  assert.equal(guard.active(), true);
  elapsed += 15_000;
  assert.equal(guard.pulse(), true);
  assert.equal(guard.failed(), true);
  assert.equal(guard.failures, 1);
  assert.equal(guard.active(), true);
  assert.equal(guard.failed(), true);
  assert.equal(guard.failures, 2);
  assert.equal(guard.active(), true);
  assert.equal(guard.completed(), true);
  assert.equal(guard.failures, 0);
  assert.equal(guard.pulse(), true);
  assert.equal(guard.stop(), true);
  assert.equal(guard.pulse(), false);
  assert.equal(states.filter((state) => state === "stopped").length, 1);
  assert.ok(failures.includes(0));
  assert.ok(failures.includes(1));
  assert.equal(guard.stop(), true);
});

test("exact watchdog deadline stops health even before next heartbeat timer", () => {
  let elapsed = 10_000;
  const states: string[] = [];
  const guard = createFeedConsumerJobHealthGuard(
    30_000,
    () => elapsed,
    (state) => states.push(state),
  );
  assert.equal(guard.ready(), true);
  assert.equal(guard.active(), true);
  elapsed += 29_999;
  assert.equal(guard.pulse(), true);
  elapsed++;
  assert.equal(guard.completed(), false);
  assert.equal(guard.stopped, true);
  assert.equal(states.at(-1), "stopped");
  assert.equal(guard.active(), false);
  assert.equal(guard.stop(), true);
  assert.equal(states.filter((state) => state === "stopped").length, 1);
});

test("three consecutive failed jobs disable the consumer without a fourth delivery", () => {
  let elapsed = 1000;
  const states: string[] = [];
  const guard = createFeedConsumerJobHealthGuard(
    60_000,
    () => elapsed,
    (state) => states.push(state),
  );
  assert.equal(guard.ready(), true);
  for (let i = 1; i <= 3; i++) {
    assert.equal(guard.active(), true);
    elapsed += 100;
    assert.equal(guard.failed(), i < 3);
    assert.equal(guard.failures, i);
  }
  assert.equal(guard.stopped, true);
  assert.equal(states.at(-1), "stopped");
  assert.equal(guard.pulse(), false);
});

test("invalid event transitions and monotonic clock rollback fail closed", () => {
  const uninitialized = createFeedConsumerJobHealthGuard(
    30_000,
    () => 100,
    () => {},
  );
  assert.equal(uninitialized.active(), false);
  assert.equal(uninitialized.stopped, true);
  const completedWithoutActive = createFeedConsumerJobHealthGuard(
    30_000,
    () => 100,
    () => {},
  );
  assert.equal(completedWithoutActive.ready(), true);
  assert.equal(completedWithoutActive.completed(), false);
  assert.equal(completedWithoutActive.stopped, true);
  let at = 1000;
  const rollback = createFeedConsumerJobHealthGuard(
    30_000,
    () => at,
    () => {},
  );
  assert.equal(rollback.ready(), true);
  at--;
  assert.equal(rollback.pulse(), false);
  assert.equal(rollback.stopped, true);
  const invalidClock = createFeedConsumerJobHealthGuard(
    30_000,
    () => NaN,
    () => {},
  );
  assert.equal(invalidClock.ready(), false);
  assert.equal(invalidClock.stopped, true);
  for (const bound of [0, 29_999, 600_001, NaN, 30_000.5]) {
    assert.throws(() => createFeedConsumerJobHealthGuard(bound));
  }
});

test("private 0600 consumer heartbeat fails immediately on timed-out processing", () => {
  const dir = mkdtempSync(join(tmpdir(), "vns-consumer-progress-"));
  const path = join(dir, "health.json");
  let elapsed = 1000;
  let wall = Date.now();
  const guard = createFeedConsumerJobHealthGuard(
    30_000,
    () => elapsed,
    (state, failures) =>
      publishFeedConsumerHealth(
        {
          version: 1,
          state,
          at: wall,
          pid: process.pid,
          consecutiveFailures: failures,
        },
        path,
      ),
  );
  try {
    assert.equal(
      checkFeedConsumerHealth(path, wall, () => true),
      false,
    );
    assert.equal(guard.ready(), true);
    assert.equal(
      checkFeedConsumerHealth(path, wall, () => true),
      true,
    );
    assert.equal(guard.active(), true);
    elapsed += 30_000;
    wall += 30_000;
    assert.equal(guard.pulse(), false);
    assert.equal(
      checkFeedConsumerHealth(path, wall, () => true),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed health writes never turn an unhealthy worker back to ready", () => {
  const bad = createFeedConsumerJobHealthGuard(
    30_000,
    () => 1000,
    () => {
      throw Error("synthetic unavailable private heartbeat");
    },
  );
  assert.equal(bad.ready(), false);
  assert.equal(bad.stopped, true);
  assert.equal(bad.active(), false);
  assert.equal(bad.stop(), true);
});
