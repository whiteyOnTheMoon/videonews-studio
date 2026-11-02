import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishFeedConsumerHealth, checkFeedConsumerHealth } from "./feed-consumer-health.js";
import {
  createFeedProjectionHealthGuard,
  FEED_PROJECTOR_MAX_SOURCE_MS,
} from "./feed-projector-health.js";

test("projector remains healthy during bounded pause, not during a stalled source", () => {
  let time = 100_000;
  const records: Array<{ state: "ready" | "stopped"; at: number }> = [];
  const guard = createFeedProjectionHealthGuard(
    () => time,
    (state, at) => records.push({ state, at }),
  );
  assert.equal(guard.pulse(), true);
  time += 15 * 60_000;
  assert.equal(guard.pulse(), true); // A 15-minute approved pause is not a failure.
  guard.beginSource();
  time += FEED_PROJECTOR_MAX_SOURCE_MS;
  assert.equal(guard.pulse(), true);
  time++;
  assert.equal(guard.pulse(), false);
  assert.deepEqual(records.at(-1), { state: "stopped", at: time });
  assert.equal(guard.pulse(), false);
  assert.throws(() => guard.beginSource());
  assert.throws(() => guard.finishSource());
  guard.stop();
  assert.equal(records.filter((x) => x.state === "stopped").length, 1);
});

test("successful projections reset their watchdog and failed clock is not healthy", () => {
  let time = 10_000;
  const records: string[] = [];
  const guard = createFeedProjectionHealthGuard(
    () => time,
    (state) => records.push(state),
  );
  guard.beginSource();
  time += 5_000;
  guard.finishSource();
  time += 60 * 60_000;
  assert.equal(guard.pulse(), true); // Long configured pause is allowed.
  guard.beginSource();
  time += 5_000;
  guard.finishSource();
  guard.stop();
  assert.deepEqual(records, ["ready", "stopped"]);
  assert.equal(guard.pulse(), false);
  const wrong = createFeedProjectionHealthGuard(
    () => NaN,
    () => undefined,
  );
  assert.equal(wrong.pulse(), false);
  const rollback = createFeedProjectionHealthGuard(
    (() => {
      const times = [100, 99];
      return () => times.shift() ?? 99;
    })(),
    () => undefined,
  );
  assert.equal(rollback.pulse(), true);
  assert.equal(rollback.pulse(), false);
});

test("private on-disk projector heartbeat shares strict Docker health file contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "vns-projector-health-"));
  const path = join(dir, "projector.json");
  let time = Date.now();
  const guard = createFeedProjectionHealthGuard(
    () => time,
    (state, at) =>
      publishFeedConsumerHealth(
        { version: 1, state, at, pid: process.pid, consecutiveFailures: 0 },
        path,
      ),
  );
  try {
    assert.equal(
      checkFeedConsumerHealth(path, time, () => true),
      false,
    );
    assert.equal(guard.pulse(), true);
    assert.equal(
      checkFeedConsumerHealth(path, time, () => true),
      true,
    );
    time += 89_999;
    assert.equal(
      checkFeedConsumerHealth(path, time, () => true),
      true,
    );
    time += 2;
    assert.equal(
      checkFeedConsumerHealth(path, time, () => true),
      false,
    );
    guard.stop();
    assert.equal(
      checkFeedConsumerHealth(path, time, () => true),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source that finishes beyond its bound is rejected even between heartbeats", () => {
  let time = 1000;
  const guard = createFeedProjectionHealthGuard(
    () => time,
    () => undefined,
  );
  guard.beginSource();
  time += FEED_PROJECTOR_MAX_SOURCE_MS + 1;
  assert.throws(() => guard.finishSource(), /watchdog exceeded/);
  assert.equal(guard.pulse(), false);
});
