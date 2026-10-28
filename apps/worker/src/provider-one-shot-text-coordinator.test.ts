import assert from "node:assert/strict";
import test from "node:test";
import type { dormantProviderBudgetBridge } from "./provider-budget-worker-bridge.js";
import { openaiFixture } from "./provider-native-usage-fixtures.js";
import { dormantOneShotTextCoordinator } from "./provider-one-shot-text-coordinator.js";

const request = Object.freeze({
  jobId: "a4310001-0000-4000-8000-000000000001",
  requestId: "ci_text_dispatch_0043",
  provider: "openai" as const,
  model: "operator-chosen-model",
  priceSnapshotId: "a4310002-0000-4000-8000-000000000002",
  maxInputTokens: 512,
  maxOutputTokens: 64,
});
const ID = "a4310003-0000-4000-8000-000000000003";
const CLAIM = "a4310004-0000-4000-8000-000000000004";
const KEY = "ci-only-never-a-real-vendor-key-123456";

function fixtureBridge(
  events: string[],
  options: { preProjectionFail?: boolean; claimError?: boolean; settleError?: boolean } = {},
) {
  let claimed = false;
  let projections = 0;
  const bridge = {
    async reserve() {
      events.push("reserve");
      return ID;
    },
    async projection() {
      projections++;
      events.push("projection");
      if (options.preProjectionFail && projections === 1) throw Error("secret-query");
      return {
        reservation_id: ID,
        job_id: request.jobId,
        request_id: request.requestId,
        provider: request.provider,
        model: request.model,
        price_version: "ci_price_version_0043",
        currency: "USD",
        reserved_micro_usd: "300",
        max_input_tokens: "512",
        max_output_tokens: "64",
        input_micro_usd_per_million: "1000000",
        cached_input_micro_usd_per_million: "250000",
        output_micro_usd_per_million: "2000000",
      };
    },
    async claim() {
      events.push("claim");
      if (claimed || options.claimError) throw Error("Provider dispatch claim unavailable");
      claimed = true;
      return CLAIM;
    },
    async halt(_id: string, fault: string) {
      assert.equal(_id, ID);
      events.push("halt:" + fault);
    },
    async settle(_id: string, usage: { costMicroUsd: string }) {
      events.push("settle");
      assert.equal(_id, ID);
      assert.equal(usage.costMicroUsd, "162");
      if (options.settleError) throw Error("secret-transaction");
      return "settled";
    },
  };
  return bridge as unknown as ReturnType<typeof dormantProviderBudgetBridge>;
}

test("coordinator defaults off and cannot reach a credential or transport", () => {
  const events: string[] = [];
  assert.throws(
    () =>
      dormantOneShotTextCoordinator(
        fixtureBridge(events),
        {
          send: async () => {
            events.push("send");
            return openaiFixture;
          },
        },
        { withCredential: async (_p, cb) => cb(KEY) },
      ),
    /Provider text coordinator disabled/,
  );
  assert.deepEqual(events, []);
});

test("committed claim is always prior to reading a key and sending one request", async () => {
  const events: string[] = [];
  const bridge = fixtureBridge(events);
  const coordinator = dormantOneShotTextCoordinator(
    bridge,
    {
      send: async (input, key) => {
        events.push("send");
        assert.equal(input.prompt, "Only facts verified from sources.");
        assert.equal(key, KEY);
        return openaiFixture;
      },
    },
    {
      withCredential: async (provider, callback) => {
        events.push("credential");
        assert.equal(provider, "openai");
        return callback(KEY);
      },
    },
    true,
  );
  const result = await coordinator.run(request, "Only facts verified from sources.");
  assert.deepEqual(result, { reservationId: ID, costMicroUsd: "162", reconciled: true });
  assert.deepEqual(events, [
    "reserve",
    "projection",
    "claim",
    "credential",
    "send",
    "projection",
    "settle",
  ]);
  await assert.rejects(
    coordinator.run(request, "Only facts verified from sources."),
    /claim unavailable/,
  );
  assert.equal(events.filter((event) => event === "send").length, 1);
  assert.equal(events.filter((event) => event === "credential").length, 1);
});

test("invalid input never reserves, claims, reads keys or touches network", async () => {
  const events: string[] = [];
  const coordinator = dormantOneShotTextCoordinator(
    fixtureBridge(events),
    {
      send: async () => {
        events.push("send");
        return openaiFixture;
      },
    },
    {
      withCredential: async (_provider, callback) => {
        events.push("key");
        return callback(KEY);
      },
    },
    true,
  );
  for (const prompt of ["", "A".repeat(40000)]) {
    await assert.rejects(coordinator.run(request, prompt), /Provider text request invalid/);
  }
  await assert.rejects(
    coordinator.run({ ...request, model: "http://untrusted.invalid" }, "Valid text"),
    /Provider text request invalid/,
  );
  await assert.rejects(
    coordinator.run({ ...request, maxOutputTokens: 0 }, "Valid text"),
    /Provider text request invalid/,
  );
  assert.deepEqual(events, []);
});

test("uncertain SQL claim must never read credentials or attempt a send", async () => {
  const events: string[] = [];
  const coordinator = dormantOneShotTextCoordinator(
    fixtureBridge(events, { claimError: true }),
    {
      send: async () => {
        events.push("send");
        return openaiFixture;
      },
    },
    {
      withCredential: async (_provider, callback) => {
        events.push("credential");
        return callback(KEY);
      },
    },
    true,
  );
  await assert.rejects(
    coordinator.run(request, "Valid text"),
    /Provider dispatch claim unavailable/,
  );
  assert.deepEqual(events, ["reserve", "projection", "claim"]);
});

test("missing SQL projection freezes budget and denies dispatch", async () => {
  const events: string[] = [];
  const coordinator = dormantOneShotTextCoordinator(
    fixtureBridge(events, { preProjectionFail: true }),
    {
      send: async () => {
        events.push("send");
        return openaiFixture;
      },
    },
    {
      withCredential: async (_provider, callback) => {
        events.push("credential");
        return callback(KEY);
      },
    },
    true,
  );
  await assert.rejects(coordinator.run(request, "Valid text"), /Provider budget review required/);
  assert.deepEqual(events, ["reserve", "projection", "halt:settlement_unconfirmed"]);
});

test("key retrieval or unknown transport result halts forever after one claim", async () => {
  for (const cause of ["credential", "transport", "malformed-response"] as const) {
    const events: string[] = [];
    const bridge = fixtureBridge(events);
    const coordinator = dormantOneShotTextCoordinator(
      bridge,
      {
        send: async () => {
          events.push("send");
          if (cause === "transport") throw Error("Bearer secret");
          if (cause === "malformed-response") return { ...openaiFixture, status: "incomplete" };
          return openaiFixture;
        },
      },
      {
        withCredential: async (_provider, callback) => {
          events.push("credential");
          if (cause === "credential") throw Error("private key read failed");
          return callback(KEY);
        },
      },
      true,
    );
    await assert.rejects(
      coordinator.run(request, "Valid text"),
      (e: Error) =>
        e.message === "Provider budget review required" && !e.message.includes("secret"),
    );
    assert.equal(events.filter((event) => event === "claim").length, 1);
    assert.equal(events.filter((event) => event.startsWith("halt:")).length, 1);
    assert.ok(!events.includes("settle"));
    if (cause === "credential") assert.ok(!events.includes("send"));
    await assert.rejects(coordinator.run(request, "Valid text"), /claim unavailable/);
    assert.equal(events.filter((event) => event === "send").length, cause === "credential" ? 0 : 1);
  }
});

test("credential callback may call the transport at most once per SQL claim", async () => {
  const events: string[] = [];
  const bridge = fixtureBridge(events);
  const coordinator = dormantOneShotTextCoordinator(
    bridge,
    {
      send: async () => {
        events.push("send");
        return openaiFixture;
      },
    },
    {
      withCredential: async (_provider, callback) => {
        await callback(KEY);
        return callback(KEY);
      },
    },
    true,
  );
  await assert.rejects(coordinator.run(request, "Valid text"), /Provider budget review required/);
  assert.equal(events.filter((item) => item === "send").length, 1);
  assert.equal(events.filter((item) => item === "claim").length, 1);
  assert.equal(events.filter((item) => item === "halt:response_missing").length, 1);
  await assert.rejects(coordinator.run(request, "Valid text"), /claim unavailable/);
  assert.equal(events.filter((item) => item === "send").length, 1);
});

test("credential callback omission is an uncertain outcome and must halt", async () => {
  const events: string[] = [];
  const coordinator = dormantOneShotTextCoordinator(
    fixtureBridge(events),
    {
      send: async () => {
        events.push("send");
        return openaiFixture;
      },
    },
    { withCredential: async <T>() => undefined as T },
    true,
  );
  await assert.rejects(coordinator.run(request, "Valid text"), /Provider budget review required/);
  assert.equal(events.includes("send"), false);
  assert.equal(events.filter((item) => item === "halt:response_missing").length, 1);
});
