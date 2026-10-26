import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { createGatedFeedBullmqBridge } from "./feed-bullmq-bridge.js";
import { ISOLATED_FEED_QUEUE } from "./feed-queue-contract.js";
import type { OfflineFeedScheduler } from "./feed-scheduler-composition.js";

const gates: NodeJS.ProcessEnv = {
  VNS_FEED_BULLMQ_BRIDGE_ENABLED: "true",
  VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
  VNS_FEED_QUEUE_OPERATOR_ACK: "true",
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_NAME: ISOLATED_FEED_QUEUE,
};
const first = {} as Redis;
const second = {} as Redis;
const ports = { producer: first, consumer: second, now: () => new Date() };
const scheduler: OfflineFeedScheduler = {
  sourceIds: ["rss_feed", "atom_feed", "json_feed"],
  async tick() {
    return [];
  },
};

test("no BullMQ object or Redis interaction unless each gate is independently enabled", () => {
  for (const name of Object.keys(gates)) {
    assert.throws(
      () => createGatedFeedBullmqBridge({ ...gates, [name]: "false" }, scheduler, ports),
      /disabled/,
      name,
    );
  }
  assert.throws(() => createGatedFeedBullmqBridge({}, scheduler, ports), /disabled/);
});

test("invalid ports, duplicate source IDs, shared connection and wrong queue are refused", () => {
  assert.throws(
    () => createGatedFeedBullmqBridge(gates, scheduler, { ...ports, consumer: first }),
    /ports refused/,
  );
  assert.throws(
    () =>
      createGatedFeedBullmqBridge(gates, scheduler, {
        ...ports,
        now: undefined as unknown as () => Date,
      }),
    /ports refused/,
  );
  assert.throws(
    () =>
      createGatedFeedBullmqBridge(
        gates,
        { ...scheduler, sourceIds: ["rss_feed", "rss_feed", "json_feed"] },
        ports,
      ),
    /ports refused/,
  );
  assert.throws(
    () =>
      createGatedFeedBullmqBridge({ ...gates, VNS_FEED_QUEUE_NAME: "vns-jobs" }, scheduler, ports),
    /disabled/,
  );
});
