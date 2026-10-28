import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { dormantProviderBudgetBridge } from "./provider-budget-worker-bridge.js";
import { openaiFixture } from "./provider-native-usage-fixtures.js";
import { processOneShotRecordedFixture } from "./provider-one-shot-fixture-dispatch.js";

const DIGEST = createHash("sha256").update("Recorded fixture prompt").digest("hex");
const reservationId = "a3900001-0000-4000-8000-000000000001";
const claimId = "a3900002-0000-4000-8000-000000000002";
const receiptId = "a3900003-0000-4000-8000-000000000003";
const request = Object.freeze({
  jobId: "a3900004-0000-4000-8000-000000000004",
  requestId: "ci_claim_fixture_req_001",
  provider: "openai" as const,
  model: "operator-chosen-model",
  priceSnapshotId: "a3900005-0000-4000-8000-000000000005",
  maxInputTokens: 100,
  maxOutputTokens: 100,
});

function memorySql(options: { claimFailure?: boolean; missingUsage?: boolean } = {}) {
  const events: string[] = [];
  let claimed = false;
  const query = async (sql: string) => {
    if (sql.includes("reserve_authorized_provider_live_budget")) {
      events.push("reserve");
      return { rows: [{ id: reservationId }] };
    }
    if (sql.includes("claim_provider_live_dispatch")) {
      events.push("claim");
      if (options.claimFailure) throw Error("db-secret-never-logged");
      if (claimed) return { rows: [{ id: null }] };
      claimed = true;
      return { rows: [{ id: claimId }] };
    }
    if (sql.includes("get_provider_live_reservation")) {
      events.push("projection");
      return {
        rows: [
          {
            reservation_id: reservationId,
            job_id: request.jobId,
            request_id: request.requestId,
            provider: "openai",
            model: request.model,
            price_version: "ci_reviewed_price_0001",
            currency: "USD",
            reserved_micro_usd: "300",
            max_input_tokens: "100",
            max_output_tokens: "100",
            input_micro_usd_per_million: "1000000",
            cached_input_micro_usd_per_million: "250000",
            output_micro_usd_per_million: "2000000",
          },
        ],
      };
    }
    if (sql.includes("halt_provider_live_budget")) {
      events.push("halt");
      return { rows: [{ halted: true }] };
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      events.push(sql);
      return { rows: [] };
    }
    if (sql.includes("record_provider_usage_evidence")) {
      events.push("record");
      return { rows: [{ id: receiptId }] };
    }
    if (sql.includes("settle_provider_live_budget")) {
      events.push("settle");
      return { rows: [{ status: "settled" }] };
    }
    throw Error("Unexpected SQL in one-shot fixture test");
  };
  const pool = {
    query,
    async connect() {
      return { query, release() {} };
    },
  } as unknown as Pick<Pool, "query" | "connect">;
  return { bridge: dormantProviderBudgetBridge(pool, true), events };
}

test("one and only one recorded response can follow an SQL dispatch claim", async () => {
  const { bridge, events } = memorySql();
  const first = await processOneShotRecordedFixture(bridge, request, openaiFixture, DIGEST);
  assert.equal(first.reservationId, reservationId);
  assert.equal(first.costMicroUsd, "162");
  assert.equal(first.reconciled, true);
  assert.deepEqual(events.slice(0, 4), ["reserve", "claim", "projection", "BEGIN"]);
  assert.equal(events.filter((event) => event === "claim").length, 1);
  assert.equal(events.filter((event) => event === "reserve").length, 1);
  assert.equal(events.filter((event) => event === "settle").length, 1);
  await assert.rejects(
    processOneShotRecordedFixture(bridge, request, openaiFixture, DIGEST),
    /Provider dispatch claim unavailable/,
  );
  assert.equal(events.filter((event) => event === "claim").length, 2);
  assert.equal(events.filter((event) => event === "reserve").length, 2);
  assert.equal(events.filter((event) => event === "record").length, 1);
  assert.equal(events.filter((event) => event === "settle").length, 1);
});

test("claim persistence uncertainty cannot process any response", async () => {
  const { bridge, events } = memorySql({ claimFailure: true });
  await assert.rejects(
    processOneShotRecordedFixture(bridge, request, openaiFixture, DIGEST),
    (error: Error) =>
      error.message === "Provider dispatch claim unavailable" &&
      !error.message.includes("db-secret"),
  );
  assert.deepEqual(events, ["reserve", "claim"]);
});

test("invalid or missing vendor-shaped response after claim halts permanently", async () => {
  for (const response of [null, { ...openaiFixture, status: "incomplete" }]) {
    const { bridge, events } = memorySql();
    await assert.rejects(
      processOneShotRecordedFixture(bridge, request, response, DIGEST),
      /Provider budget review required/,
    );
    assert.deepEqual(events.slice(0, 4), ["reserve", "claim", "projection", "halt"]);
    assert.equal(events.at(-1), "halt");
    assert.equal(events.includes("record"), false);
    await assert.rejects(
      processOneShotRecordedFixture(bridge, request, openaiFixture, DIGEST),
      /Provider dispatch claim unavailable/,
    );
    assert.equal(events.includes("record"), false);
  }
});

test("an unavailable budget does not create a claim or measured receipt", async () => {
  const { bridge, events } = memorySql();
  await assert.rejects(
    processOneShotRecordedFixture(bridge, { ...request, maxInputTokens: 0 }, openaiFixture, DIGEST),
    /Provider budget request invalid/,
  );
  assert.deepEqual(events, []);
});
