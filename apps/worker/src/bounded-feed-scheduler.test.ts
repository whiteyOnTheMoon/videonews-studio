import assert from "node:assert/strict";
import test from "node:test";
import { readBoundedFeedSchedule, runBoundedFeedSchedule } from "./bounded-feed-scheduler.js";

const env: NodeJS.ProcessEnv = {
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_SIGNED_EXPORT_ENABLED: "true",
  VNS_FEED_SOURCE_ANCHOR_APPROVED: "true",
  VNS_FEED_SIGNED_SOURCE_INBOX: "/var/lib/vns/feed-source-inbox",
  VNS_FEED_SOURCE_CHECKPOINT_DIR: "/var/lib/vns/feed-source-checkpoint",
  VNS_FEED_SOURCE_PUBLIC_KEY_FILE: "/run/secrets/vns_feed_source_public_key",
  VNS_FEED_SOURCE_ANCHOR_PASSWORD_FILE: "/run/secrets/vns_feed_source_anchor_password",
  VNS_FEED_SOURCE_ANCHOR_CA_FILE: "/run/secrets/vns_feed_source_anchor_ca",
  VNS_FEED_SOURCE_ANCHOR_HOST: "source-anchor.example.org",
  VNS_FEED_SOURCE_ANCHOR_USER: "vns_anchor_login_worker",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
  VNS_FEED_RUNTIME_OPERATOR_ACK: "true",
  VNS_FEED_RIGHTS_ATTESTED: "true",
  VNS_FEED_NETWORK_APPROVED: "true",
  VNS_FEED_RUNTIME_MODE: "single_pass",
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
  VNS_FEED_QUEUE_OPERATOR_ACK: "true",
  VNS_FEED_BULLMQ_BRIDGE_ENABLED: "true",
  VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_NAME: "vns-feed-poll",
  VNS_FEED_REGISTRY_FILE: "/run/secrets/reviewed_research_sources.json",
  VNS_FEED_DB_PASSWORD_FILE: "/run/secrets/vns_feed_db_password",
  VNS_FEED_REDIS_PASSWORD_FILE: "/run/secrets/vns_feed_redis_password",
  VNS_FEED_DB_HOST: "postgres",
  VNS_FEED_REDIS_HOST: "redis",
  VNS_FEED_DB_USER: "vns_feed_login_observer",
  VNS_FEED_REDIS_USER: "vns_feed_observer",
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: "news.example.org",
  VNS_FEED_SCHEDULER_ENABLED: "true",
  VNS_FEED_SCHEDULER_OPERATOR_ACK: "true",
  VNS_FEED_SCHEDULER_MODE: "bounded",
  VNS_FEED_SCHEDULER_MAX_TICKS: "3",
  VNS_FEED_SCHEDULER_FAILURE_LIMIT: "2",
};

const START = Date.parse("2026-10-26T12:00:00.000Z");
function fixture(initialTime = START + 3 * 60000) {
  let clock = initialTime;
  let calls = 0;
  const delays: number[] = [];
  const events: Array<{ event: string; slot: number; failures: number }> = [];
  return {
    get calls() { return calls; },
    get delays() { return delays; },
    get events() { return events; },
    ports: {
      now: () => new Date(clock),
      async delay(ms: number, signal: AbortSignal) {
        assert.equal(signal.aborted, false);
        assert.ok(ms > 0 && ms <= 900000);
        delays.push(ms);
        clock += ms;
      },
      async observe() {
        calls++;
        return { ok: true as const, sourcesExamined: 3, candidatesAdded: 0, notModified: 3 };
      },
      record(event: "tick_ok" | "tick_failed" | "halted", fields: {slot: number; consecutiveFailures: number}) {
        events.push({ event, slot: fields.slot, failures: fields.consecutiveFailures });
      },
    },
  };
}

test("scheduler starts only after every existing source/rights/anchor/queue approval", async () => {
  const valid = readBoundedFeedSchedule(env);
  assert.deepEqual(valid, { maxTicks: 3, failureLimit: 2 });
  for (const field of [
    "VNS_FEED_SCHEDULER_ENABLED",
    "VNS_FEED_SCHEDULER_OPERATOR_ACK",
    "VNS_FEED_SCHEDULER_MODE",
    "VNS_FEED_SIGNED_EXPORT_ENABLED",
    "VNS_FEED_SOURCE_ANCHOR_APPROVED",
    "VNS_FEED_NETWORK_APPROVED",
    "VNS_FEED_QUEUE_OPERATOR_ACK",
    "VNS_FEED_RUNTIME_OPERATOR_ACK",
  ]) {
    const f = fixture();
    await assert.rejects(
      runBoundedFeedSchedule({ ...env, [field]: undefined }, f.ports, new AbortController().signal),
    );
    assert.equal(f.calls, 0);
    assert.equal(f.delays.length, 0);
  }
  for (const change of [
    { VNS_FEED_SCHEDULER_MAX_TICKS: "0" },
    { VNS_FEED_SCHEDULER_MAX_TICKS: "17" },
    { VNS_FEED_SCHEDULER_MAX_TICKS: "-1" },
    { VNS_FEED_SCHEDULER_MAX_TICKS: "2.5" },
    { VNS_FEED_SCHEDULER_FAILURE_LIMIT: "4" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
  ]) assert.throws(() => readBoundedFeedSchedule({ ...env, ...change }));
});

test("late startup skips missed slot and each new slot runs at most once", async () => {
  const f = fixture();
  const result = await runBoundedFeedSchedule(env, f.ports, new AbortController().signal);
  assert.deepEqual(result, { attempted: 3, succeeded: 3, failures: 0 });
  assert.equal(f.calls, 3);
  assert.deepEqual(f.delays, [12 * 60000, 15 * 60000, 15 * 60000]);
  assert.deepEqual(f.events.map((x) => x.event), ["tick_ok", "tick_ok", "tick_ok"]);
  assert.equal(new Set(f.events.map((x) => x.slot)).size, 3);
});

test("a failing tick only retries on the next slot and halts after consecutive failures", async () => {
  const f = fixture(START);
  f.ports.observe = async () => {
    throw new Error("SECRET_SOURCE_ENDPOINT");
  };
  await assert.rejects(
    runBoundedFeedSchedule(env, f.ports, new AbortController().signal),
    /stopped after repeated failures/,
  );
  assert.equal(f.calls, 0);
  assert.deepEqual(f.events.map((x) => x.event), ["tick_failed", "tick_failed", "halted"]);
  assert.deepEqual(f.delays, [15 * 60000]);
  assert.equal(JSON.stringify(f.events).includes("SECRET"), false);
});

test("failed observation is not counted as success and next slot may recover", async () => {
  const f = fixture(START);
  let times = 0;
  f.ports.observe = async () => {
    times++;
    if (times === 1) throw new Error("SECRET_DB_PASSWORD");
    return { ok: true, sourcesExamined: 3, candidatesAdded: 1, notModified: 0 };
  };
  const result = await runBoundedFeedSchedule(env, f.ports, new AbortController().signal);
  assert.deepEqual(result, { attempted: 3, succeeded: 2, failures: 1 });
  assert.equal(times, 3);
  assert.deepEqual(f.events.map((x) => x.event), ["tick_failed", "tick_ok", "tick_ok"]);
});

test("shutdown cancels the next interval without starting another feed request", async () => {
  const f = fixture(START);
  const controller = new AbortController();
  let calls = 0;
  f.ports.observe = async () => {
    calls++;
    controller.abort();
    return { ok: true, sourcesExamined: 3, candidatesAdded: 0, notModified: 0 };
  };
  assert.deepEqual(
    await runBoundedFeedSchedule(env, f.ports, controller.signal),
    { attempted: 1, succeeded: 1, failures: 0 },
  );
  assert.equal(calls, 1);
});
