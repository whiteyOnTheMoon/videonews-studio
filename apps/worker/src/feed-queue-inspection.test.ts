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
