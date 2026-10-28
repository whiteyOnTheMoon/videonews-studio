import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  dormantProviderBudgetBridge,
  replayProviderBudgetFixture,
  type BudgetReplayRequest,
} from "./provider-budget-worker-bridge.js";
import { openaiFixture } from "./provider-native-usage-fixtures.js";

const reservationId = "a3800001-0000-4000-8000-000000000001";
const FIXTURE_DIGEST = createHash("sha256").update("Verified offline fixture").digest("hex");
const receiptId = "a3800002-0000-4000-8000-000000000002";
const request: BudgetReplayRequest = Object.freeze({
  jobId: "a3800003-0000-4000-8000-000000000003",
  requestId: "ci_bridge_request_00001",
  provider: "openai",
  model: "operator-chosen-model",
  priceSnapshotId: "a3800004-0000-4000-8000-000000000004",
  maxInputTokens: 100,
  maxOutputTokens: 100,
});

function projection(overrides: Record<string, unknown> = {}) {
  return {
    reservation_id: reservationId,
    job_id: request.jobId,
    request_id: request.requestId,
    provider: request.provider,
    model: request.model,
    price_version: "ci_reviewed_price_0001",
    currency: "USD",
    reserved_micro_usd: "300",
    max_input_tokens: "100",
    max_output_tokens: "100",
    input_micro_usd_per_million: "1000000",
    cached_input_micro_usd_per_million: "250000",
    output_micro_usd_per_million: "2000000",
    ...overrides,
  };
}

function mockDatabase(
  options: {
    projectionOverride?: Record<string, unknown>;
    settlement?: "settled" | "halted";
    failure?: "reserve" | "projection" | "record" | "settle" | "halt";
  } = {},
) {
  const events: string[] = [];
  let inTransaction = false;
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("reserve_authorized_provider_live_budget")) {
      events.push("reserve");
      assert.deepEqual(params, [
        request.jobId,
        request.provider,
        request.model,
        request.requestId,
        request.priceSnapshotId,
        100,
        100,
        FIXTURE_DIGEST,
      ]);
      if (options.failure === "reserve") throw Error("db-password-must-not-appear");
      return { rows: [{ id: reservationId }] };
    }
    if (sql.includes("get_provider_live_reservation")) {
      events.push("projection");
      assert.deepEqual(params, [reservationId]);
      if (options.failure === "projection") throw Error("db-password-must-not-appear");
      return { rows: [projection(options.projectionOverride)] };
    }
    if (sql.includes("halt_provider_live_budget")) {
      events.push("halt");
      assert.equal(params[0], reservationId);
      if (options.failure === "halt") throw Error("db-password-must-not-appear");
      return { rows: [{ halted: true }] };
    }
    if (sql === "BEGIN") {
      events.push("BEGIN");
      inTransaction = true;
      return { rows: [] };
    }
    if (sql.includes("record_provider_usage_evidence")) {
      events.push("record");
      assert.equal(inTransaction, true);
      assert.deepEqual(params, [
        request.jobId,
        request.provider,
        request.model,
        request.requestId,
        openaiFixture.id,
        "ci_reviewed_price_0001",
        "100",
        "40",
        "25",
        "162",
      ]);
      if (options.failure === "record") throw Error("db-password-must-not-appear");
      return { rows: [{ id: receiptId }] };
    }
    if (sql.includes("settle_provider_live_budget")) {
      events.push("settle");
      assert.equal(inTransaction, true);
      assert.deepEqual(params, [reservationId, receiptId]);
      if (options.failure === "settle") throw Error("db-password-must-not-appear");
      return { rows: [{ status: options.settlement ?? "settled" }] };
    }
    if (sql === "COMMIT" || sql === "ROLLBACK") {
      events.push(sql);
      inTransaction = false;
      return { rows: [] };
    }
    throw Error("Unexpected SQL");
  };
  const db = {
    query,
    async connect() {
      events.push("connect");
      return {
        query,
        release() {
          events.push("release");
        },
      };
    },
  } as unknown as Pick<Pool, "query" | "connect">;
  return { db, events };
}

test("budget bridge is dormant, and rejects noncanonical requests before SQL", async () => {
  const { db, events } = mockDatabase();
  assert.throws(() => dormantProviderBudgetBridge(db), /disabled/);
  const bridge = dormantProviderBudgetBridge(db, true);
  await assert.rejects(
    bridge.reserve({ ...request, provider: "unknown" as never }, FIXTURE_DIGEST),
    /Provider budget request invalid/,
  );
  await assert.rejects(
    bridge.reserve({ ...request, maxInputTokens: 0 }, FIXTURE_DIGEST),
    /Provider budget request invalid/,
  );
  await assert.rejects(
    bridge.reserve({ ...request, requestId: "bad" }, FIXTURE_DIGEST),
    /Provider budget request invalid/,
  );
  await assert.rejects(
    bridge.reserve(request, "invalid-digest"),
    /Provider budget request invalid/,
  );
  assert.deepEqual(events, []);
});

test("recorded native usage is committed atomically after a SQL-authorized reserve", async () => {
  const { db, events } = mockDatabase();
  const result = await replayProviderBudgetFixture(
    dormantProviderBudgetBridge(db, true),
    request,
    openaiFixture,
    FIXTURE_DIGEST,
  );
  assert.deepEqual(result, {
    reservationId,
    costMicroUsd: "162",
    reconciled: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(events, [
    "reserve",
    "projection",
    "connect",
    "BEGIN",
    "record",
    "settle",
    "COMMIT",
    "release",
  ]);
});

test("missing usage persists a durable halt without recording a false zero", async () => {
  const { db, events } = mockDatabase();
  await assert.rejects(
    replayProviderBudgetFixture(
      dormantProviderBudgetBridge(db, true),
      request,
      null,
      FIXTURE_DIGEST,
    ),
    /Provider budget review required/,
  );
  assert.deepEqual(events, ["reserve", "projection", "halt"]);
});

test("incomplete and contradictory usage halt before a receipt exists", async () => {
  for (const response of [
    { ...openaiFixture, usage: undefined },
    { ...openaiFixture, status: "incomplete" },
    { ...openaiFixture, usage: { ...openaiFixture.usage, total_tokens: 139 } },
    { ...openaiFixture, id: "forged" },
  ]) {
    const { db, events } = mockDatabase();
    await assert.rejects(
      replayProviderBudgetFixture(
        dormantProviderBudgetBridge(db, true),
        request,
        response,
        FIXTURE_DIGEST,
      ),
      /Provider budget review required/,
    );
    assert.deepEqual(events, ["reserve", "projection", "halt"]);
  }
});

test("over-reservation cost and token exhaustion halt rather than undercount", async () => {
  for (const override of [{ reserved_micro_usd: "161" }, { max_input_tokens: "99" }]) {
    const { db, events } = mockDatabase({ projectionOverride: override });
    await assert.rejects(
      replayProviderBudgetFixture(
        dormantProviderBudgetBridge(db, true),
        request,
        openaiFixture,
        FIXTURE_DIGEST,
      ),
      /Provider budget review required/,
    );
    assert.deepEqual(events, ["reserve", "projection", "halt"]);
  }
  const { db, events } = mockDatabase();
  const native = {
    ...openaiFixture,
    usage: {
      ...openaiFixture.usage,
      input_tokens: 101,
      total_tokens: 141,
    },
  };
  await assert.rejects(
    replayProviderBudgetFixture(
      dormantProviderBudgetBridge(db, true),
      request,
      native,
      FIXTURE_DIGEST,
    ),
    /Provider budget review required/,
  );
  assert.deepEqual(events, ["reserve", "projection", "halt"]);
});

test("forged SQL price projection always fails closed and halts", async () => {
  for (const patch of [
    { price_version: "a" },
    { provider: "google_gemini" },
    { currency: "EUR" },
    { input_micro_usd_per_million: "-1" },
    { cached_input_micro_usd_per_million: "1000001" },
  ]) {
    const { db, events } = mockDatabase({ projectionOverride: patch });
    await assert.rejects(
      replayProviderBudgetFixture(
        dormantProviderBudgetBridge(db, true),
        request,
        openaiFixture,
        FIXTURE_DIGEST,
      ),
      /Provider budget review required/,
    );
    assert.deepEqual(events, ["reserve", "projection", "halt"]);
  }
});

test("database outages and uncertain settle roll back before durable halt", async () => {
  for (const failure of ["record", "settle"] as const) {
    const { db, events } = mockDatabase({ failure });
    await assert.rejects(
      replayProviderBudgetFixture(
        dormantProviderBudgetBridge(db, true),
        request,
        openaiFixture,
        FIXTURE_DIGEST,
      ),
      /Provider budget review required/,
    );
    const expectedSequence = [
      "reserve",
      "projection",
      "connect",
      "BEGIN",
      "record",
      ...(failure === "settle" ? ["settle"] : []),
      "ROLLBACK",
      "release",
      "halt",
    ];
    assert.deepEqual(events, expectedSequence);
  }
});

test("SQL-reported halt commits the incident and is never accepted as settlement", async () => {
  const { db, events } = mockDatabase({ settlement: "halted" });
  await assert.rejects(
    replayProviderBudgetFixture(
      dormantProviderBudgetBridge(db, true),
      request,
      openaiFixture,
      FIXTURE_DIGEST,
    ),
    /Provider budget review required/,
  );
  assert.deepEqual(events.slice(-3), ["settle", "COMMIT", "release"]);
  assert.equal(events.includes("halt"), false);
});

test("failed emergency halt is a hard error without leaking DB credentials", async () => {
  const { db } = mockDatabase({ failure: "halt" });
  await assert.rejects(
    replayProviderBudgetFixture(
      dormantProviderBudgetBridge(db, true),
      request,
      null,
      FIXTURE_DIGEST,
    ),
    (error: Error) =>
      error.message === "Provider emergency halt unavailable" &&
      !error.message.includes("db-password"),
  );
});

test("reserve failure cannot continue into a receipt", async () => {
  const { db, events } = mockDatabase({ failure: "reserve" });
  await assert.rejects(
    replayProviderBudgetFixture(
      dormantProviderBudgetBridge(db, true),
      request,
      openaiFixture,
      FIXTURE_DIGEST,
    ),
    /Provider budget reservation unavailable/,
  );
  assert.deepEqual(events, ["reserve"]);
});
