import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { providerUsageEvidenceStore } from "./provider-usage-evidence-store.js";

const input = Object.freeze({
  jobId: "ecbe0001-1111-4111-8111-111111111111",
  requestId: "usage_request_00001",
  responseId: "usage_response_00001",
  provider: "openai",
  model: "test-model",
  priceVersion: "test_price_v0001",
  currency: "USD",
  inputTokens: 100,
  outputTokens: 40,
  cachedInputTokens: 25,
  costMicroUsd: "250",
});

test("provider receipts are opt-in and never imply payment approval", async () => {
  assert.throws(
    () => providerUsageEvidenceStore({} as Pick<Pool, "query">, false),
    /disabled/,
  );
  let calls = 0;
  const pool = {
    async query(statement: string, params: unknown[]) {
      calls++;
      assert.match(statement, /^SELECT vns\.record_provider_usage_evidence\(/);
      assert.deepEqual(params, [
        input.jobId,
        input.provider,
        input.model,
        input.requestId,
        input.responseId,
        input.priceVersion,
        "100",
        "40",
        "25",
        "250",
      ]);
      return { rows: [{ id: "bbea0001-1111-4111-8111-111111111111" }] };
    },
  } as unknown as Pick<Pool, "query">;
  const receipt = await providerUsageEvidenceStore(pool, true).record(input);
  assert.equal(calls, 1);
  assert.deepEqual(receipt, {
    receiptId: "bbea0001-1111-4111-8111-111111111111",
    source: "provider_response",
    calculatedCostMicroUsd: "250",
    currency: "USD",
    persistent: true,
    reconciled: false,
    approvedForPayment: false,
  });
  assert.ok(Object.isFrozen(receipt));
});

test("invalid adapter data never reaches DB, failure diagnostics are sanitized", async () => {
  let calls = 0;
  const pool = {
    async query() {
      calls++;
      throw new Error("postgres://ci-secret-must-not-appear");
    },
  } as unknown as Pick<Pool, "query">;
  const store = providerUsageEvidenceStore(pool, true);
  await assert.rejects(store.record({ ...input, apiKey: "ci-leak" }), /Invalid provider usage/);
  assert.equal(calls, 0);
  await assert.rejects(
    store.record(input),
    (error: Error) =>
      error.message === "Provider evidence persistence unavailable" &&
      !error.message.includes("ci-secret"),
  );
  assert.equal(calls, 1);
});
