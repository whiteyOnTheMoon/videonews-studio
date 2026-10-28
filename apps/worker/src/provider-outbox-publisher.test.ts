import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { sealProviderPrompt } from "@vns/shared";
import {
  dormantProviderOutboxPublisher,
  PROVIDER_OUTBOX_REDIS_TARGET,
  type ProviderOutboxJob,
  type ProviderRedisQueuePort,
} from "./provider-outbox-publisher.js";

const JOB = "a4810001-0000-4000-8000-000000000001";
const PRICE = "a4810002-0000-4000-8000-000000000002";
const key = randomBytes(32);
const prompt = "Approved source evidence and article facts.";
const sealed = sealProviderPrompt(prompt, key);
const row = {
  job_id: JOB,
  request_id: "ci_provider_redis_request_48",
  provider: "openai",
  model: "ci_reviewed_model",
  price_snapshot_id: PRICE,
  prompt_sha256: sealed.sha256,
  max_input_tokens: 100,
  max_output_tokens: 32,
  envelope_version: 1,
  iv_base64: sealed.iv,
  tag_base64: sealed.tag,
  ciphertext_base64: sealed.ciphertext,
};
const scope = async <T>(operation: (key: Buffer) => Promise<T>) => operation(key);
function setup() {
  const jobs = new Map<string, ProviderOutboxJob>();
  let reads = 0;
  let added = 0;
  let acks = 0;
  let failAck = false;
  const sql = {
    async query(query: string, args: unknown[]) {
      if (query.includes("read_authorized_provider_outbox")) {
        reads++;
        assert.deepEqual(args, [5]);
        return { rows: acks > 0 ? [] : [row] };
      }
      assert.match(query, /ack_provider_outbox_delivery/);
      assert.deepEqual(args, [JOB]);
      if (failAck) {
        failAck = false;
        throw Error("database outage");
      }
      acks++;
      return { rows: [{ acknowledged: true }] };
    },
  };
  const queue: ProviderRedisQueuePort = {
    async getJob(id) {
      return jobs.get(id);
    },
    async add(name, data, opts) {
      added++;
      const job = { id: opts.jobId, name, data, opts };
      jobs.set(opts.jobId, job);
      return job;
    },
  };
  return {
    sql,
    queue,
    jobs,
    setFailAck: () => { failAck = true; },
    reads: () => reads,
    adds: () => added,
    acks: () => acks,
  };
}
test("disabled by default and consumer queue prefix matches", () => {
  const ports = setup();
  assert.throws(() => dormantProviderOutboxPublisher(ports.sql as never, ports.queue, scope), /disabled/);
  assert.equal(PROVIDER_OUTBOX_REDIS_TARGET.name, "vns-provider-text");
  assert.equal(PROVIDER_OUTBOX_REDIS_TARGET.prefix, "bull:vns");
  assert.equal(ports.reads(), 0);
});

test("SQL ciphertext is decrypted, validated, persisted and acknowledged exactly once", async () => {
  const p = setup();
  const send = dormantProviderOutboxPublisher(p.sql as never, p.queue, scope, true);
  assert.deepEqual(await send.runOnce(), { verified: 1, acknowledged: 1 });
  assert.deepEqual(await send.runOnce(), { verified: 0, acknowledged: 0 });
  assert.equal(p.adds(), 1);
  assert.equal(p.acks(), 1);
  const published = p.jobs.get(JOB)!;
  assert.equal(published.data.prompt, prompt);
  assert.equal(published.opts.attempts, 1);
  assert.equal(published.opts.removeOnComplete, false);
  assert.equal(published.opts.removeOnFail, false);
});

test("crash after Redis publication is reconciled without re-enqueue", async () => {
  const p = setup();
  const send = dormantProviderOutboxPublisher(p.sql as never, p.queue, scope, true);
  p.setFailAck();
  await assert.rejects(send.runOnce(), /unavailable/);
  assert.equal(p.adds(), 1);
  assert.equal(p.acks(), 0);
  const restarted = dormantProviderOutboxPublisher(p.sql as never, p.queue, scope, true);
  assert.deepEqual(await restarted.runOnce(), { verified: 1, acknowledged: 1 });
  assert.equal(p.adds(), 1);
  assert.equal(p.acks(), 1);
});

test("forged Redis collision and corrupt envelope never receive SQL acknowledgement", async () => {
  const p = setup();
  p.jobs.set(JOB, {
    id: JOB,
    name: "provider-text",
    data: { request: { jobId: JOB }, prompt: "malicious prompt" },
    opts: { jobId: JOB, attempts: 1, removeOnComplete: false, removeOnFail: false },
  });
  const send = dormantProviderOutboxPublisher(p.sql as never, p.queue, scope, true);
  await assert.rejects(send.runOnce(), /unavailable/);
  assert.equal(p.acks(), 0);
  assert.equal(p.adds(), 0);

  const corruptedSql = {
    async query(q: string) {
      if (q.includes("read_authorized_provider_outbox")) {
        return { rows: [{ ...row, prompt_sha256: "0".repeat(64) }] };
      }
      throw Error("unexpected acknowledgement");
    },
  };
  const clean = setup();
  await assert.rejects(
    dormantProviderOutboxPublisher(corruptedSql as never, clean.queue, scope, true).runOnce(),
    /unavailable/,
  );
  assert.equal(clean.adds(), 0);
});

test("producer denies unauthenticated rows, malformed SQL responses and arbitrary limits", async () => {
  const p = setup();
  const send = dormantProviderOutboxPublisher(p.sql as never, p.queue, scope, true);
  for (const size of [0, 11, 1.5, -1]) {
    await assert.rejects(send.runOnce(size), /unavailable/);
  }
  assert.equal(p.reads(), 0);
  const alteredSql = {
    async query() {
      return { rows: [{ ...row, max_output_tokens: 10000 }] };
    },
  };
  await assert.rejects(
    dormantProviderOutboxPublisher(alteredSql as never, p.queue, scope, true).runOnce(),
    /unavailable/,
  );
  assert.equal(p.adds(), 0);
});
