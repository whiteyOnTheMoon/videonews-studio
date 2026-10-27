import assert from "node:assert/strict";
import { test } from "node:test";
import { QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import {
  createSeparatedFeedProducer,
  createSeparatedFeedConsumer,
} from "../apps/worker/dist/feed-bullmq-separated.js";
import { ISOLATED_FEED_QUEUE } from "../apps/worker/dist/feed-queue-contract.js";
import { ISOLATED_FEED_REDIS_PREFIX } from "../apps/worker/dist/feed-bullmq-bridge.js";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CI !== "true" ||
  process.env.VNS_P2_ISOLATED_PORT_TEST !== "true"
) {
  throw new Error("Separate real-port test only runs on disposable CI infrastructure");
}

const base = {
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
  VNS_FEED_DB_PASSWORD_FILE: "/run/secrets/vns_feed_db_password",
  VNS_FEED_REDIS_PASSWORD_FILE: "/run/secrets/vns_feed_redis_password",
  VNS_FEED_SOURCE_PUBLIC_KEY_FILE: "/run/secrets/vns_feed_source_public_key",
  VNS_FEED_SOURCE_ANCHOR_PASSWORD_FILE: "/run/secrets/vns_feed_source_anchor_password",
  VNS_FEED_SOURCE_ANCHOR_CA_FILE: "/run/secrets/vns_feed_source_anchor_ca",
  VNS_FEED_SIGNED_SOURCE_INBOX: "/var/lib/vns/feed-source-inbox",
  VNS_FEED_SOURCE_CHECKPOINT_DIR: "/var/lib/vns/feed-source-checkpoint",
  VNS_FEED_QUEUE_NAME: ISOLATED_FEED_QUEUE,
  VNS_FEED_REGISTRY_FILE: "/run/secrets/reviewed_research_sources.json",
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: "news.example.org",
};
const producerUser = "vns_feed_producer_ciunit";
const consumerUser = "vns_feed_consumer_ciunit";
const producerPassword = "ci_producer_isolated_ephemeral_password";
const consumerPassword = "ci_consumer_isolated_ephemeral_password";
const producerEnv = {
  ...base,
  VNS_FEED_RUNTIME_MODE: "bounded_producer",
  VNS_FEED_REDIS_USER: producerUser,
  VNS_FEED_SEPARATE_PRODUCER_ENABLED: "true",
  VNS_FEED_SEPARATE_PRODUCER_OPERATOR_ACK: "true",
  VNS_FEED_SCHEDULER_ENABLED: "true",
  VNS_FEED_SCHEDULER_OPERATOR_ACK: "true",
  VNS_FEED_SCHEDULER_MODE: "bounded",
  VNS_FEED_SCHEDULER_MAX_TICKS: "2",
  VNS_FEED_SCHEDULER_FAILURE_LIMIT: "2",
};
const consumerEnv = {
  ...base,
  VNS_FEED_RUNTIME_MODE: "persistent_worker",
  VNS_FEED_REDIS_USER: consumerUser,
  VNS_FEED_SEPARATE_WORKER_ENABLED: "true",
  VNS_FEED_SEPARATE_WORKER_OPERATOR_ACK: "true",
};

test("real isolated Redis: distinct ACL identities, durable slot delivery and restarted consumer", { timeout: 60000 }, async () => {
  const address = { host: "127.0.0.1", port: 6379 };
  const admin = new Redis(address);
  const producerRedis = new Redis({
    ...address,
    username: producerUser,
    password: producerPassword,
    maxRetriesPerRequest: null,
  });
  const consumerRedis = new Redis({
    ...address,
    username: consumerUser,
    password: consumerPassword,
    maxRetriesPerRequest: null,
  });
  // Created after ACL provisioning below. No real publisher or source access.
  producerRedis.on("error", () => undefined);
  consumerRedis.on("error", () => undefined);
  const events = new QueueEvents(ISOLATED_FEED_QUEUE, {
    connection: address,
    prefix: ISOLATED_FEED_REDIS_PREFIX,
  });
  let producer;
  let consumer;
  let admittedJobs = 0;
  let closedContexts = 0;
  let syntheticNow = new Date(Math.floor(Date.now() / 900000) * 900000 + 900000);
  const openContext = async () => {
    admittedJobs++;
    return {
      scheduler: {
        sourceIds: ["ci_rss", "ci_atom", "ci_json"],
        async tick() {
          return [];
        },
      },
      async close() {
        closedContexts++;
      },
    };
  };
  try {
    for (const [username, password] of [
      [producerUser, producerPassword],
      [consumerUser, consumerPassword],
    ]) {
      await admin.acl(
        "SETUSER",
        username,
        "on",
        ">" + password,
        "~bull:vns:feed:*",
        "+@all",
        "-@admin",
        "-@dangerous",
      );
    }
    await events.waitUntilReady();
    producer = createSeparatedFeedProducer(producerEnv, producerRedis);
    consumer = createSeparatedFeedConsumer(consumerEnv, consumerRedis, openContext, () => syntheticNow);
    await Promise.all([producer.queue.waitUntilReady(), consumer.worker.waitUntilReady()]);
    await assert.rejects(producerRedis.set("outside:source", "never"), /NOPERM/);
    await assert.rejects(consumerRedis.get("outside:source"), /NOPERM/);

    const id = await producer.enqueue(syntheticNow);
    assert.equal(await producer.enqueue(syntheticNow), id);
    const job = await producer.queue.getJob(id);
    assert.ok(job);
    assert.deepEqual(await job.waitUntilFinished(events, 20000), {
      ok: true,
      sourcesExamined: 0,
      candidatesAdded: 0,
      notModified: 0,
    });
    assert.equal(admittedJobs, 1);
    assert.equal(closedContexts, 1);
    await consumer.close();
    consumer = undefined;

    // Restart the consumer without rebuilding the queue; the next durable
    // time slot is accepted under a freshly created processing context.
    const restartedConnection = new Redis({
      ...address,
      username: consumerUser,
      password: consumerPassword,
      maxRetriesPerRequest: null,
    });
    restartedConnection.on("error", () => undefined);
    try {
      syntheticNow = new Date(syntheticNow.getTime() + 900000);
      consumer = createSeparatedFeedConsumer(consumerEnv, restartedConnection, openContext, () => syntheticNow);
      await consumer.worker.waitUntilReady();
      const nextId = await producer.enqueue(syntheticNow);
      const nextJob = await producer.queue.getJob(nextId);
      assert.ok(nextJob);
      assert.equal((await nextJob.waitUntilFinished(events, 20000)).ok, true);
      assert.equal(admittedJobs, 2);
      assert.equal(closedContexts, 2);
    } finally {
      await consumer?.close().catch(() => undefined);
      consumer = undefined;
      await restartedConnection.quit().catch(() => restartedConnection.disconnect());
    }
  } finally {
    await consumer?.close().catch(() => undefined);
    await producer?.close().catch(() => undefined);
    await events.close().catch(() => undefined);
    await producerRedis.quit().catch(() => producerRedis.disconnect());
    await consumerRedis.quit().catch(() => consumerRedis.disconnect());
    await admin.acl("DELUSER", producerUser, consumerUser).catch(() => undefined);
    await admin.quit().catch(() => admin.disconnect());
  }
});
