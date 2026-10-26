import assert from "node:assert/strict";
import test from "node:test";
import {
  createDormantFeedQueueContract,
  FEED_TICK_JOB_NAME,
  ISOLATED_FEED_QUEUE,
  type FeedQueuePort,
  type FeedTickDelivery,
} from "./feed-queue-contract.js";
import type { OfflineFeedScheduler } from "./feed-scheduler-composition.js";
import type { PollResult } from "./feed-poller.js";

const START = Date.parse("2026-10-26T12:00:00.000Z");
const ENV: NodeJS.ProcessEnv = {
  VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
  VNS_FEED_QUEUE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_NAME: ISOLATED_FEED_QUEUE,
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
};
const IDS = ["agency_rss", "agency_atom", "agency_json"];

function fixture() {
  const queued = new Map<string, FeedTickDelivery>();
  const records: Array<{ name: string; data: unknown; options: unknown }> = [];
  let ticks = 0;
  let results: readonly PollResult[] = [
    { sourceId: IDS[0]!, status: "ingested", newItems: 2 },
    { sourceId: IDS[1]!, status: "not_modified", newItems: 0 },
    { sourceId: IDS[2]!, status: "ingested", newItems: 0 },
  ];
  const queue: FeedQueuePort = {
    name: ISOLATED_FEED_QUEUE,
    async add(name, data, options) {
      records.push({ name, data, options });
      if (!queued.has(options.jobId)) {
        queued.set(options.jobId, {
          id: options.jobId,
          name,
          queueName: ISOLATED_FEED_QUEUE,
          data,
        });
      }
      return { id: options.jobId };
    },
  };
  const scheduler: OfflineFeedScheduler = {
    sourceIds: IDS,
    async tick() {
      ticks++;
      return results;
    },
  };
  return {
    queue,
    scheduler,
    records,
    queued,
    get ticks() {
      return ticks;
    },
    setResults(value: readonly PollResult[]) {
      results = value;
    },
  };
}

test("one deterministic BullMQ job per 15-minute slot; no secrets or source links", async () => {
  const f = fixture();
  const orchestration = createDormantFeedQueueContract(ENV, f.scheduler, f.queue);
  const first = await orchestration.enqueue(new Date(START));
  assert.equal(first, await orchestration.enqueue(new Date(START + 14 * 60000)));
  assert.equal(f.queued.size, 1);
  assert.equal(f.records.length, 2);
  assert.deepEqual(f.records[0], {
    name: FEED_TICK_JOB_NAME,
    data: { kind: FEED_TICK_JOB_NAME, slot: Math.floor(START / 900000) },
    options: {
      jobId: first,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
  const next = await orchestration.enqueue(new Date(START + 15 * 60000));
  assert.notEqual(first, next);
  assert.equal(f.queued.size, 2);
  assert.equal(JSON.stringify(f.records).includes("https://"), false);
  assert.equal(JSON.stringify(f.records).includes("password"), false);
  assert.equal(f.ticks, 0);
});

test("valid isolated job processes a single bounded tick with aggregate status only", async () => {
  const f = fixture();
  const service = createDormantFeedQueueContract(ENV, f.scheduler, f.queue);
  const now = new Date(START);
  const id = await service.enqueue(now);
  const result = await service.process(f.queued.get(id)!, now);
  assert.deepEqual(result, {
    ok: true,
    sourcesExamined: 3,
    candidatesAdded: 2,
    notModified: 1,
  });
  assert.equal(f.ticks, 1);
  assert.equal(JSON.stringify(result).includes("agency_"), false);
  f.setResults([]);
  assert.deepEqual(await service.process(f.queued.get(id)!, now), {
    ok: true,
    sourcesExamined: 0,
    candidatesAdded: 0,
    notModified: 0,
  });
});

test("shared/probe/research queue jobs and forged URLs or stale slots are rejected", async () => {
  const f = fixture();
  const service = createDormantFeedQueueContract(ENV, f.scheduler, f.queue);
  const now = new Date(START);
  const id = await service.enqueue(now);
  const valid = f.queued.get(id)!;
  const invalid: FeedTickDelivery[] = [
    { ...valid, queueName: "vns-jobs" },
    { ...valid, queueName: "vns-research" },
    { ...valid, name: "probe" },
    { ...valid, id: "arbitrary" },
    { ...valid, data: { kind: FEED_TICK_JOB_NAME, slot: Math.floor(START / 900000), url: "https://bad" } },
    { ...valid, data: { kind: FEED_TICK_JOB_NAME, slot: -1 } },
    { ...valid, data: { kind: "render", slot: Math.floor(START / 900000) } },
    { ...valid, data: {} },
  ];
  for (const item of invalid) {
    await assert.rejects(service.process(item, now), /delivery refused/);
  }
  await assert.rejects(service.process(valid, new Date(START - 1)), /delivery refused/);
  await assert.rejects(
    service.process(valid, new Date(START + 30 * 60000)),
    /delivery refused/,
  );
  assert.equal(f.ticks, 0);
});

test("fail-closed flags and incorrect queue name cannot schedule anything", async () => {
  const keys = [
    "VNS_FEED_QUEUE_CONTRACT_ENABLED",
    "VNS_FEED_QUEUE_OPERATOR_ACK",
    "VNS_FEED_OFFLINE_COMPOSITION_ENABLED",
    "VNS_FEED_OFFLINE_OPERATOR_ACK",
  ];
  for (const key of keys) {
    const f = fixture();
    assert.throws(
      () => createDormantFeedQueueContract({ ...ENV, [key]: "false" }, f.scheduler, f.queue),
      /disabled/,
    );
    assert.equal(f.records.length, 0);
  }
  const f = fixture();
  assert.throws(
    () => createDormantFeedQueueContract({ ...ENV, VNS_FEED_QUEUE_NAME: "vns-jobs" }, f.scheduler, f.queue),
    /disabled/,
  );
  assert.throws(
    () => createDormantFeedQueueContract(ENV, f.scheduler, { ...f.queue, name: "vns-research" }),
    /ports not approved/,
  );
  assert.throws(
    () => createDormantFeedQueueContract(ENV, { ...f.scheduler, sourceIds: IDS.slice(0, 2) }, f.queue),
    /ports not approved/,
  );
  assert.equal(f.records.length, 0);
});

test("unknown sources, duplicate results, invalid counts and failed feeds never pass as success", async () => {
  const f = fixture();
  const service = createDormantFeedQueueContract(ENV, f.scheduler, f.queue);
  const now = new Date(START);
  const id = await service.enqueue(now);
  const job = f.queued.get(id)!;
  const errors: readonly (readonly PollResult[])[] = [
    [{ sourceId: "unapproved", status: "ingested", newItems: 1 }],
    [
      { sourceId: IDS[0]!, status: "ingested", newItems: 1 },
      { sourceId: IDS[0]!, status: "ingested", newItems: 1 },
    ],
    [{ sourceId: IDS[0]!, status: "ingested", newItems: 22 }],
    [{ sourceId: IDS[0]!, status: "failed", newItems: 0 }],
    [{ sourceId: IDS[0]!, status: "not_modified", newItems: 1 }],
  ];
  for (const result of errors) {
    f.setResults(result);
    await assert.rejects(service.process(job, now), /execution failed/);
  }
});

test("execution and enqueue errors are sanitized; concurrent delivery is refused", async () => {
  const f = fixture();
  const queue: FeedQueuePort = {
    name: ISOLATED_FEED_QUEUE,
    async add() {
      throw new Error("SECRET_QUEUE_PASSWORD");
    },
  };
  const failedEnqueue = createDormantFeedQueueContract(ENV, f.scheduler, queue);
  await assert.rejects(
    failedEnqueue.enqueue(new Date(START)),
    (error: unknown) => error instanceof Error && error.message === "Feed queue enqueue unavailable",
  );

  let release: (() => void) | undefined;
  const locked: OfflineFeedScheduler = {
    sourceIds: IDS,
    tick: () =>
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
  };
  const service = createDormantFeedQueueContract(ENV, locked, f.queue);
  const id = await service.enqueue(new Date(START));
  const job = f.queued.get(id)!;
  const inFlight = service.process(job, new Date(START));
  await assert.rejects(service.process(job, new Date(START)), /delivery refused/);
  assert.ok(release);
  release();
  assert.equal((await inFlight).ok, true);
  await assert.rejects(service.enqueue(new Date("invalid")), /clock invalid/);
});
