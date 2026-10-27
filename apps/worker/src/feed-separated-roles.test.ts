import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { createGatedFeedSlotEnqueuer, ISOLATED_FEED_QUEUE } from "./feed-queue-contract.js";
import {
  requireSeparatedFeedGate,
  createSeparatedFeedProducer,
  createSeparatedFeedConsumer,
} from "./feed-bullmq-separated.js";
import { readFeedRuntimeAdmission } from "./feed-runtime-admission.js";

const login = "vns_feed_login_observer";
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
  VNS_FEED_DB_USER: login,
  VNS_FEED_REDIS_USER: "vns_feed_observer",
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: "news.example.org",
};

test("producer and consumer are independently opt-in and cannot impersonate one another", () => {
  const producer = {
    ...env,
    VNS_FEED_RUNTIME_MODE: "bounded_producer",
    VNS_FEED_REDIS_USER: "vns_feed_producer_restricted",
    VNS_FEED_SEPARATE_PRODUCER_ENABLED: "true",
    VNS_FEED_SEPARATE_PRODUCER_OPERATOR_ACK: "true",
    VNS_FEED_SCHEDULER_ENABLED: "true",
    VNS_FEED_SCHEDULER_OPERATOR_ACK: "true",
    VNS_FEED_SCHEDULER_MODE: "bounded",
    VNS_FEED_SCHEDULER_MAX_TICKS: "2",
    VNS_FEED_SCHEDULER_FAILURE_LIMIT: "2",
  };
  const consumer = {
    ...env,
    VNS_FEED_RUNTIME_MODE: "persistent_worker",
    VNS_FEED_REDIS_USER: "vns_feed_consumer_restricted",
    VNS_FEED_SEPARATE_WORKER_ENABLED: "true",
    VNS_FEED_SEPARATE_WORKER_OPERATOR_ACK: "true",
  };
  assert.doesNotThrow(() => requireSeparatedFeedGate(producer, "producer"));
  assert.doesNotThrow(() => requireSeparatedFeedGate(consumer, "consumer"));
  for (const change of [
    { VNS_FEED_SEPARATE_PRODUCER_ENABLED: "false" },
    { VNS_FEED_SEPARATE_PRODUCER_OPERATOR_ACK: "false" },
    { VNS_FEED_RUNTIME_MODE: "single_pass" },
    { VNS_FEED_REDIS_USER: "vns_feed_consumer_restricted" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
    { VNS_FEED_SCHEDULER_ENABLED: "false" },
  ]) {
    assert.throws(() => requireSeparatedFeedGate({ ...producer, ...change }, "producer"));
  }
  for (const change of [
    { VNS_FEED_SEPARATE_WORKER_ENABLED: "false" },
    { VNS_FEED_SEPARATE_WORKER_OPERATOR_ACK: "false" },
    { VNS_FEED_RUNTIME_MODE: "bounded_producer" },
    { VNS_FEED_REDIS_USER: "vns_feed_producer_restricted" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
    { VNS_FEED_SIGNED_EXPORT_ENABLED: "false" },
  ]) {
    assert.throws(() => requireSeparatedFeedGate({ ...consumer, ...change }, "consumer"));
  }
  assert.throws(() => requireSeparatedFeedGate(producer, "consumer"));
  assert.throws(() => requireSeparatedFeedGate(consumer, "producer"));
  assert.throws(() => readFeedRuntimeAdmission(producer), /not authorized/);
  assert.throws(() => readFeedRuntimeAdmission(consumer), /not authorized/);
  assert.equal(
    readFeedRuntimeAdmission(producer, "bounded_producer").redisUser,
    "vns_feed_producer_restricted",
  );
  assert.equal(
    readFeedRuntimeAdmission(consumer, "persistent_worker").redisUser,
    "vns_feed_consumer_restricted",
  );
  // No connection should be touched when a role is not approved.
  assert.throws(() => createSeparatedFeedProducer(env, undefined as unknown as Redis));
  assert.throws(() =>
    createSeparatedFeedConsumer(env, undefined as unknown as Redis, async () => {
      throw Error("Must not open context");
    }),
  );
});

test("queue-only producer preserves fixed slot deduplication and never needs sources", async () => {
  const sent: unknown[] = [];
  const queue = {
    name: ISOLATED_FEED_QUEUE,
    async add(name: string, data: unknown, options: unknown) {
      sent.push({ name, data, options });
    },
  };
  const gates = {
    VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
    VNS_FEED_QUEUE_OPERATOR_ACK: "true",
    VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
    VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
    VNS_FEED_QUEUE_NAME: ISOLATED_FEED_QUEUE,
  };
  const enqueue = createGatedFeedSlotEnqueuer(gates, queue);
  const t = new Date("2026-10-26T12:00:00Z");
  assert.equal(await enqueue(t), await enqueue(new Date(t.getTime() + 60000)));
  assert.equal(sent.length, 2);
  assert.equal(JSON.stringify(sent).includes("https://"), false);
  assert.equal(JSON.stringify(sent).includes("secret"), false);
  for (const key of Object.keys(gates)) {
    assert.throws(() => createGatedFeedSlotEnqueuer({ ...gates, [key]: "false" }, queue));
  }
  assert.throws(() => createGatedFeedSlotEnqueuer(gates, { ...queue, name: "vns-jobs" }));
  await assert.rejects(enqueue(new Date("invalid")), /clock invalid/);
});
