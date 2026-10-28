import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { DormantEditorialCheckpointStore } from "./dormant-editorial-checkpoint-store.js";

const event = "ca300003-3333-4333-8333-333333333333";
const actor = "ca300002-2222-4222-8222-222222222222";
const enabled = {
  VNS_EDITORIAL_CHECKPOINT_OFFLINE_ENABLED: "true",
  VNS_EDITORIAL_CHECKPOINT_OPERATOR_ACK: "true",
};

test("explicit opt-in required before any SQL is touched", () => {
  let queries = 0;
  const pool = {
    async query() {
      queries++;
      return { rows: [] };
    },
  } as unknown as Pool;
  assert.throws(() => new DormantEditorialCheckpointStore(pool, {}), /disabled/);
  assert.throws(
    () =>
      new DormantEditorialCheckpointStore(pool, {
        ...enabled,
        VNS_EDITORIAL_CHECKPOINT_OPERATOR_ACK: "false",
      }),
    /disabled/,
  );
  assert.equal(queries, 0);
});

test("parameters are bound and DB owns the personal session identity", async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    async query(sql: string, args: unknown[]) {
      calls.push({ sql, args });
      return { rows: [{ saved: calls.length === 1 }] };
    },
  } as unknown as Pool;
  const store = new DormantEditorialCheckpointStore(pool, enabled);
  assert.equal(
    await store.append(event, 0, "ranking", "candidate", "a".repeat(64), ["offline_candidate"], 42),
    "saved",
  );
  assert.equal(
    await store.append(event, 0, "ranking", "candidate", "a".repeat(64), ["offline_candidate"], 42),
    "conflict",
  );
  assert.deepEqual(calls[0]?.args, [
    event,
    0,
    "ranking",
    "candidate",
    "a".repeat(64),
    '["offline_candidate"]',
    42,
  ]);
  assert.ok(calls.every((call) => !call.sql.includes(event)));
  assert.ok(calls.every((call) => !call.sql.includes("editorId")));
});

test("invalid payload and untrusted response are rejected without leaking SQL", async () => {
  let count = 0;
  const pool = {
    async query() {
      count++;
      return { rows: [{ saved: "true" }] };
    },
  } as unknown as Pool;
  const store = new DormantEditorialCheckpointStore(pool, enabled);
  await assert.rejects(
    store.append("bad", 0, "ranking", "candidate", "a".repeat(64), ["valid_reason"], 5),
    /invalid/,
  );
  await assert.rejects(
    store.append(event, 0, "ranking", "candidate", "a".repeat(64), ["invalid secret"], 5),
    /invalid/,
  );
  assert.equal(count, 0);
  await assert.rejects(
    store.append(event, 0, "ranking", "candidate", "a".repeat(64), ["valid_reason"], 5),
    /unavailable/,
  );
});

test("bounded cursor export validates every record and masks rejected data", async () => {
  const record = {
    revision: 1,
    stage: "ranking",
    outcome: "candidate",
    actor_id: actor,
    artifact_sha256: "a".repeat(64),
    reason_codes: ["offline_candidate"],
    score: 42,
    previous_sha256: "0".repeat(64),
    chain_sha256: "b".repeat(64),
    recorded_at: new Date("2026-10-26T12:00:00.000Z"),
  };
  const pool = {
    async query() {
      return { rows: [record] };
    },
  } as unknown as Pool;
  const store = new DormantEditorialCheckpointStore(pool, enabled);
  const page = await store.export(event, 0, 10);
  assert.equal(page[0]?.revision, 1);
  assert.equal(Object.isFrozen(page[0]?.reason_codes), true);
  await assert.rejects(store.export(event, 1, 10), /invalid/);
  await assert.rejects(store.export(event, -1, 10), /invalid/);
  await assert.rejects(store.export(event, 0, 10, "a".repeat(64)), /invalid/);
  await assert.rejects(store.export(event, 1, 10, "not_a_digest"), /invalid/);
});

test("worker export validates genesis, exact revisions and linked page digests", async () => {
  const first = {
    revision: 1,
    stage: "ranking",
    outcome: "candidate",
    actor_id: actor,
    artifact_sha256: "a".repeat(64),
    reason_codes: ["metadata_candidate_only"],
    score: 42,
    previous_sha256: "0".repeat(64),
    chain_sha256: "b".repeat(64),
    recorded_at: new Date("2026-10-26T12:00:00.000Z"),
  };
  const second = {
    ...first,
    revision: 2,
    stage: "quality",
    outcome: "needs_review",
    previous_sha256: first.chain_sha256,
    chain_sha256: "c".repeat(64),
  };
  let records: unknown[] = [first, second];
  const pool = {
    async query() {
      return { rows: records };
    },
  } as unknown as Pool;
  const store = new DormantEditorialCheckpointStore(pool, enabled);
  assert.deepEqual(
    (await store.export(event, 0, 10)).map((row) => row.revision),
    [1, 2],
  );
  records = [second];
  assert.equal((await store.export(event, 1, 10, first.chain_sha256))[0]?.revision, 2);
  for (const corrupted of [
    { ...first, previous_sha256: "f".repeat(64) },
    { ...first, revision: 2 },
    { ...first, stage: "published" },
    { ...first, outcome: "approved" },
    { ...first, score: 1001 },
    { ...first, reason_codes: [99] },
    { ...first, reason_codes: [] },
    { ...first, actor_id: "invalid" },
  ]) {
    records = [corrupted];
    await assert.rejects(store.export(event, 0, 10), /unavailable/);
  }
  records = [first, { ...second, previous_sha256: "f".repeat(64) }];
  await assert.rejects(store.export(event, 0, 10), /unavailable/);
  records = [second];
  await assert.rejects(store.export(event, 1, 10, "f".repeat(64)), /unavailable/);
});

