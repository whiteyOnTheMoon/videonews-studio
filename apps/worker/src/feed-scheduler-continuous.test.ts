import assert from "node:assert/strict";
import test from "node:test";
import { readFeedConsumerWatchdogSeconds } from "./feed-consumer-watchdog.js";
import {
  readContinuousFeedPolicy,
  runContinuousFeedSchedule,
  validateFeedQueueSnapshot,
  type FeedQueueSnapshot,
} from "./feed-scheduler-continuous.js";

const env: NodeJS.ProcessEnv = {
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_RUNTIME_OPERATOR_ACK: "true",
  VNS_FEED_RIGHTS_ATTESTED: "true",
  VNS_FEED_NETWORK_APPROVED: "true",
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
  VNS_FEED_QUEUE_OPERATOR_ACK: "true",
  VNS_FEED_BULLMQ_BRIDGE_ENABLED: "true",
  VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK: "true",
  VNS_FEED_SIGNED_EXPORT_ENABLED: "true",
  VNS_FEED_SOURCE_ANCHOR_APPROVED: "true",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
  VNS_FEED_SOURCE_ANCHOR_HOST: "anchor.example.org",
  VNS_FEED_SOURCE_ANCHOR_USER: "vns_anchor_login_ciunit",
  VNS_FEED_DB_HOST: "127.0.0.1",
  VNS_FEED_DB_USER: "vns_feed_login_ciunit",
  VNS_FEED_REDIS_HOST: "127.0.0.1",
  VNS_FEED_REDIS_USER: "vns_feed_producer_restricted",
  VNS_FEED_DB_PASSWORD_FILE: "/run/secrets/vns_feed_db_password",
  VNS_FEED_REDIS_PASSWORD_FILE: "/run/secrets/vns_feed_redis_password",
  VNS_FEED_SOURCE_PUBLIC_KEY_FILE: "/run/secrets/vns_feed_source_public_key",
  VNS_FEED_SOURCE_ANCHOR_PASSWORD_FILE: "/run/secrets/vns_feed_source_anchor_password",
  VNS_FEED_SOURCE_ANCHOR_CA_FILE: "/run/secrets/vns_feed_source_anchor_ca",
  VNS_FEED_SIGNED_SOURCE_INBOX: "/var/lib/vns/feed-source-inbox",
  VNS_FEED_SOURCE_CHECKPOINT_DIR: "/var/lib/vns/feed-source-checkpoint",
  VNS_FEED_QUEUE_NAME: "vns-feed-poll",
  VNS_FEED_REGISTRY_FILE: "/run/secrets/reviewed_research_sources.json",
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: "news.example.org",
  VNS_FEED_RUNTIME_MODE: "continuous_producer",
  VNS_FEED_SEPARATE_PRODUCER_ENABLED: "true",
  VNS_FEED_SEPARATE_PRODUCER_OPERATOR_ACK: "true",
  VNS_FEED_SCHEDULER_ENABLED: "true",
  VNS_FEED_SCHEDULER_OPERATOR_ACK: "true",
  VNS_FEED_SCHEDULER_MODE: "continuous",
  VNS_FEED_CONTINUOUS_ENABLED: "true",
  VNS_FEED_CONTINUOUS_OPERATOR_ACK: "true",
  VNS_FEED_CONTINUOUS_MAX_BACKLOG: "3",
  VNS_FEED_CONTINUOUS_MAX_COMPLETED_JOBS: "1000",
  VNS_FEED_CONTINUOUS_MAX_PENDING_AGE_MINUTES: "20",
  VNS_FEED_CONTINUOUS_ENQUEUE_FAILURE_LIMIT: "2",
};

const empty: FeedQueueSnapshot = {
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  completed: 0,
  paused: 0,
  queuePaused: false,
  oldestPendingAt: null,
};

test("all continuous safety gates and explicit operator limits fail closed", () => {
  assert.deepEqual(readContinuousFeedPolicy(env), {
    maxBacklog: 3,
    maxCompletedJobs: 1000,
    maxPendingAgeMinutes: 20,
    maxConsecutiveEnqueueFailures: 2,
  });
  for (const flag of [
    "VNS_FEED_CONTINUOUS_ENABLED",
    "VNS_FEED_CONTINUOUS_OPERATOR_ACK",
    "VNS_FEED_SEPARATE_PRODUCER_ENABLED",
    "VNS_FEED_SEPARATE_PRODUCER_OPERATOR_ACK",
    "VNS_FEED_RIGHTS_ATTESTED",
    "VNS_FEED_NETWORK_APPROVED",
    "VNS_FEED_SOURCE_ANCHOR_APPROVED",
    "VNS_FEED_SCHEDULER_ENABLED",
    "VNS_FEED_SCHEDULER_OPERATOR_ACK",
  ]) {
    assert.throws(() => readContinuousFeedPolicy({ ...env, [flag]: "false" }), flag);
  }
  for (const change of [
    { VNS_FEED_RUNTIME_MODE: "bounded_producer" },
    { VNS_FEED_SCHEDULER_MODE: "bounded" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
    { VNS_FEED_REDIS_USER: "vns_feed_consumer_restricted" },
    { VNS_FEED_CONTINUOUS_MAX_BACKLOG: "0" },
    { VNS_FEED_CONTINUOUS_MAX_BACKLOG: "21" },
    { VNS_FEED_CONTINUOUS_MAX_COMPLETED_JOBS: "10" },
    { VNS_FEED_CONTINUOUS_MAX_PENDING_AGE_MINUTES: "30" },
    { VNS_FEED_CONTINUOUS_ENQUEUE_FAILURE_LIMIT: "4" },
  ]) assert.throws(() => readContinuousFeedPolicy({ ...env, ...change }));
});

test("monitor rejects failed jobs, paused queues, unbounded or stale backlog", () => {
  const policy = readContinuousFeedPolicy(env);
  const now = Date.parse("2026-10-26T12:00:00Z");
  assert.equal(validateFeedQueueSnapshot(empty, policy, now), 0);
  assert.equal(
    validateFeedQueueSnapshot({ ...empty, waiting: 1, oldestPendingAt: now - 60000 }, policy, now),
    1,
  );
  const bad: FeedQueueSnapshot[] = [
    { ...empty, failed: 1 },
    { ...empty, completed: 1000 },
    { ...empty, waiting: 4, oldestPendingAt: now },
    { ...empty, waiting: 1, oldestPendingAt: now - 21 * 60000 },
    { ...empty, waiting: 1, oldestPendingAt: now + 1 },
    { ...empty, active: 1 },
    { ...empty, queuePaused: true },
    { ...empty, paused: 1, oldestPendingAt: now },
    { ...empty, failed: -1 },
    { ...empty, waiting: 1.5, oldestPendingAt: now },
  ];
  for (const snapshot of bad) {
    assert.throws(() => validateFeedQueueSnapshot(snapshot, policy, now));
  }
});

test("continuous scheduler dispatches exactly one slot, skips missed slots and shuts down cleanly", async () => {
  const controller = new AbortController();
  const slots: number[] = [];
  let clock = Date.parse("2026-10-26T12:00:00Z");
  const events: string[] = [];
  await runContinuousFeedSchedule(
    env,
    {
      now: () => new Date(clock),
      async inspect() {
        return empty;
      },
      async enqueue(now) {
        slots.push(Math.floor(now.getTime() / 900000));
        if (slots.length === 2) controller.abort();
        return "slot";
      },
      async delay(ms) {
        assert.ok(ms > 0 && ms <= 30000);
        clock += ms;
      },
      record(event) {
        events.push(event);
      },
    },
    controller.signal,
  );
  assert.equal(slots.length, 2);
  assert.equal(slots[1] - slots[0], 1);
  assert.deepEqual(events, ["slot_enqueued", "slot_enqueued"]);
});

test("queue observation failure prevents dispatch and reports only sanitized counters", async () => {
  let enqueued = false;
  const events: unknown[] = [];
  await assert.rejects(
    runContinuousFeedSchedule(
      env,
      {
        now: () => new Date("2026-10-26T12:00:00Z"),
        delay: async () => undefined,
        inspect: async () => ({ ...empty, failed: 1 }),
        enqueue: async () => {
          enqueued = true;
          return "should-not-run";
        },
        record(event, fields) {
          events.push({ event, ...fields });
        },
      },
      new AbortController().signal,
    ),
    /queue health check failed/,
  );
  assert.equal(enqueued, false);
  assert.deepEqual(events, [{ event: "queue_unhealthy", slot: 1992240, pending: 0, failed: 0 }]);
});

test("consumer watchdog requires its own independently approved bounded timeout", () => {
  const worker = {
    ...env,
    VNS_FEED_RUNTIME_MODE: "persistent_worker",
    VNS_FEED_REDIS_USER: "vns_feed_consumer_restricted",
    VNS_FEED_SEPARATE_WORKER_ENABLED: "true",
    VNS_FEED_SEPARATE_WORKER_OPERATOR_ACK: "true",
    VNS_FEED_CONSUMER_MAX_JOB_SECONDS: "180",
  };
  assert.equal(readFeedConsumerWatchdogSeconds(worker), 180);
  for (const value of ["0", "29", "601", "9999", "unbounded", ""]) {
    assert.throws(() => readFeedConsumerWatchdogSeconds({
      ...worker,
      VNS_FEED_CONSUMER_MAX_JOB_SECONDS: value,
    }));
  }
  assert.throws(() => readFeedConsumerWatchdogSeconds({
    ...worker,
    VNS_FEED_SEPARATE_WORKER_ENABLED: "false",
  }));
});
