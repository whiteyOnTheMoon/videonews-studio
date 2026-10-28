import assert from "node:assert/strict";
import test from "node:test";
import { inspectFeedQueue } from "./feed-queue-inspection.js";

type Port = Parameters<typeof inspectFeedQueue>[0];

test("queue inspector reads only aggregate counts and bounded job timestamps", async () => {
  let inspected = 0;
  const queue = {
    async getJobCounts() {
      return { waiting: 1, active: 1, delayed: 0, failed: 0, completed: 2, paused: 0 };
    },
    async getJobs() {
      inspected++;
      return [
        { timestamp: 1000, data: { url: "https://private.invalid" } },
        { timestamp: 2000, data: { password: "never-read" } },
      ];
    },
    async isPaused() {
      return false;
    },
  } as unknown as Port;
  assert.deepEqual(await inspectFeedQueue(queue), {
    waiting: 1,
    active: 1,
    delayed: 0,
    failed: 0,
    completed: 2,
    paused: 0,
    queuePaused: false,
    oldestPendingAt: 1000,
  });
  assert.equal(inspected, 1);
  assert.equal(JSON.stringify(await inspectFeedQueue(queue)).includes("private.invalid"), false);
});

test("invalid Redis responses and missing pending jobs are rejected", async () => {
  const base = {
    async getJobCounts() {
      return { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 0, paused: 0 };
    },
    async getJobs() {
      return [];
    },
    async isPaused() {
      return false;
    },
  };
  await assert.rejects(inspectFeedQueue(base as unknown as Port), /inspection unavailable/);
  await assert.rejects(
    inspectFeedQueue({
      ...base,
      getJobs: async () => [{ timestamp: Number.NaN }],
    } as unknown as Port),
    /inspection unavailable/,
  );
  await assert.rejects(
    inspectFeedQueue({
      ...base,
      getJobCounts: async () => {
        throw Error("SECRET_REDIS_ENDPOINT");
      },
    } as unknown as Port),
    (error: unknown) =>
      error instanceof Error && error.message === "Feed queue inspection unavailable",
  );
});

test("missing, forged or unbounded Redis counters fail closed before listing jobs", async () => {
  const valid = { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 0 };
  let listed = 0;
  for (const response of [
    { ...valid, failed: undefined },
    { ...valid, active: "0" },
    { ...valid, failed: -1 },
    { ...valid, completed: Infinity },
    { ...valid, waiting: 1.5 },
    { ...valid, waiting: 1_000_001 },
    null,
  ]) {
    await assert.rejects(
      inspectFeedQueue({
        async getJobCounts() {
          return response;
        },
        async getJobs() {
          listed++;
          return [{ timestamp: 1000 }];
        },
        async isPaused() {
          return false;
        },
      } as unknown as Port),
      /Feed queue inspection unavailable/,
    );
  }
  assert.equal(listed, 0);
});

test("a partial pending-job list cannot hide an older stale job", async () => {
  let checks = 0;
  await assert.rejects(
    inspectFeedQueue({
      async getJobCounts() {
        return { waiting: 2, active: 0, delayed: 0, failed: 0, completed: 0 };
      },
      async getJobs() {
        checks++;
        // The only visible job is fresh; the other could already be stale.
        return [{ timestamp: Date.parse("2026-10-28T17:00:00.000Z") }];
      },
      async isPaused() {
        return false;
      },
    } as unknown as Port),
    /Feed queue inspection unavailable/,
  );
  assert.equal(checks, 1);
});
