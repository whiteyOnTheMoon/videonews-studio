import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  estimateMicroUsd,
  syntheticUsageStore,
  validateSyntheticUsage,
} from "./token-usage.js";

const JOB_ID = "b274db39-cfd5-46bf-8438-27557b89201a";
const RECEIPT_ID = "b274db39-cfd5-46bf-8438-27557b89201b";

function sample() {
  return {
    jobId: JOB_ID,
    requestId: "ci_request_000001",
    provider: "ci_fixture",
    model: "ci-model-1",
    inputTokens: 1000,
    outputTokens: 500,
    inputMicroUsdPerMillion: 2_000_000,
    outputMicroUsdPerMillion: 8_000_000,
  };
}

test("store is dormant unless explicitly approved", () => {
  const notUsed = {} as Pool;
  assert.throws(() => syntheticUsageStore(notUsed, false), /explicitly enabled/);
  assert.throws(() => syntheticUsageStore(notUsed, undefined as never), /explicitly enabled/);
});

test("strict synthetic usage shape and integer micro-USD rounding", () => {
  const event = sample();
  assert.deepEqual(validateSyntheticUsage(event), event);
  assert.equal(estimateMicroUsd(event), "6000");
  assert.equal(estimateMicroUsd({ ...event, inputTokens: 1, outputTokens: 0,
    inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 0 }), "1");
  assert.equal(estimateMicroUsd({ ...event, inputTokens: 0, outputTokens: 0 }), "0");
  assert.equal(estimateMicroUsd({ ...event,
    inputTokens: 100_000_000, outputTokens: 100_000_000,
    inputMicroUsdPerMillion: 1_000_000_000_000,
    outputMicroUsdPerMillion: 1_000_000_000_000 }), "200000000000000");
  for (const bad of [
    null,
    [],
    { ...event, apiKey: "not allowed" },
    { ...event, inputTokens: -1 },
    { ...event, inputTokens: 0.5 },
    { ...event, outputTokens: true },
    { ...event, inputMicroUsdPerMillion: Infinity },
    { ...event, outputMicroUsdPerMillion: 1_000_000_000_001 },
    { ...event, provider: "not safe" },
    { ...event, model: "bad\nmodel" },
    { ...event, requestId: "short" },
    { ...event, jobId: "wrong" },
  ]) {
    assert.throws(() => validateSyntheticUsage(bad), /Invalid synthetic/);
  }
});

test("synthetic receipt write is parameterized and returns only a bounded acknowledgment", async () => {
  const captured: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      captured.push({ sql, params });
      return { rows: [{ id: RECEIPT_ID }] };
    },
  } as unknown as Pool;
  const output = await syntheticUsageStore(pool, true).record(sample());
  assert.deepEqual(output, {
    receiptId: RECEIPT_ID,
    estimatedCostMicroUsd: "6000",
    estimated: true,
    currency: "USD",
  });
  assert.equal(captured.length, 1);
  assert.match(captured[0].sql, /record_synthetic_token_usage/);
  assert.match(captured[0].sql, /\$8::bigint/);
  assert.deepEqual(captured[0].params, [
    JOB_ID, "ci_fixture", "ci-model-1", "ci_request_000001",
    "1000", "500", "2000000", "8000000",
  ]);
});

test("invalid input is rejected before any SQL operation", async () => {
  let called = false;
  const pool = {
    async query() {
      called = true;
      throw new Error("Unexpected DB access");
    },
  } as unknown as Pool;
  await assert.rejects(
    syntheticUsageStore(pool, true).record({ ...sample(), prompt: "private user text" }),
    /Invalid synthetic/,
  );
  assert.equal(called, false);
});

test("SQL and malformed DB results never leak raw errors", async () => {
  const failing = {
    async query() {
      throw new Error("ci database secret in failed connection");
    },
  } as unknown as Pool;
  await assert.rejects(
    syntheticUsageStore(failing, true).record(sample()),
    (error: Error) => error.message === "Synthetic token receipt unavailable",
  );
  const inconsistent = {
    async query() {
      return { rows: [{ id: "broken!" }] };
    },
  } as unknown as Pool;
  await assert.rejects(
    syntheticUsageStore(inconsistent, true).record(sample()),
    /Synthetic token receipt unavailable/,
  );
});

test("summary returns only decimal strings and cannot be queried for arbitrary IDs", async () => {
  const pool = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /sum\(estimated_cost_micro_usd\)/);
      assert.deepEqual(params, [JOB_ID]);
      return { rows: [{ requests: "2", input_tokens: "2000",
        output_tokens: "1000", estimated_cost_micro_usd: "12000" }] };
    },
  } as unknown as Pool;
  const store = syntheticUsageStore(pool, true);
  assert.deepEqual(await store.summarize(JOB_ID), {
    jobId: JOB_ID,
    requests: "2",
    inputTokens: "2000",
    outputTokens: "1000",
    estimatedCostMicroUsd: "12000",
    estimated: true,
    currency: "USD",
  });
  await assert.rejects(store.summarize("invalid"), /Invalid synthetic job ID/);
});

test("malformed summary and SQL errors are fail-closed", async () => {
  const pool = {
    async query() {
      return { rows: [{ requests: "private", input_tokens: "0",
        output_tokens: "0", estimated_cost_micro_usd: "0" }] };
    },
  } as unknown as Pool;
  await assert.rejects(
    syntheticUsageStore(pool, true).summarize(JOB_ID),
    /Synthetic token summary unavailable/,
  );
});
