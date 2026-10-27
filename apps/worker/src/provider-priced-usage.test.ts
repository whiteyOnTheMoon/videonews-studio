import assert from "node:assert/strict";
import test from "node:test";
import { quoteNativeTextUsage } from "./provider-priced-usage.js";
import { geminiFixture, openaiFixture } from "./provider-native-usage.test.js";

const price = Object.freeze({
  provider: "openai" as const,
  model: "operator-chosen-model",
  priceVersion: "reviewed_snapshot_001",
  currency: "USD" as const,
  inputMicroUsdPerMillion: "1000000",
  cachedInputMicroUsdPerMillion: "250000",
  outputMicroUsdPerMillion: "2000000",
});
const context = Object.freeze({
  jobId: "b274db39-cfd5-46bf-8438-27557b89201a",
  requestId: "provider_request_00001",
  reservedMicroUsd: "162",
});

test("checked, ceil-rounded fixed-point OpenAI prices respect existing request reservation", () => {
  const a = quoteNativeTextUsage(price, context, openaiFixture);
  const b = quoteNativeTextUsage(price, context, openaiFixture);
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a));
  assert.deepEqual(a, {
    jobId: context.jobId,
    requestId: context.requestId,
    responseId: openaiFixture.id,
    provider: "openai",
    model: "operator-chosen-model",
    priceVersion: "reviewed_snapshot_001",
    currency: "USD",
    inputTokens: 100,
    outputTokens: 40,
    cachedInputTokens: 25,
    costMicroUsd: "162",
    source: "provider_response",
    approvedForPayment: false,
    persistent: false,
  });
});

test("Gemini thinking tokens are included in separately configured output rate", () => {
  const geminiPrice = {
    ...price,
    provider: "google_gemini" as const,
    model: "operator-chosen-gemini",
  };
  const result = quoteNativeTextUsage(
    geminiPrice,
    { ...context, reservedMicroUsd: "111" },
    geminiFixture,
  );
  assert.equal(result.costMicroUsd, "111");
  assert.equal(result.outputTokens, 13);
  assert.equal(result.cachedInputTokens, 20);
});

test("unpriced, stale-shaped, mismatched or explicitly over-reservation quotes are blocked", () => {
  const invalid = [
    { ...price, priceVersion: "short" },
    { ...price, currency: "EUR" },
    { ...price, provider: "other" },
    { ...price, model: "other-model" },
    { ...price, cachedInputMicroUsdPerMillion: "1000001" },
    { ...price, inputMicroUsdPerMillion: "-1" },
    { ...price, outputMicroUsdPerMillion: "1.1" },
    { ...price, outputMicroUsdPerMillion: 123 },
    { ...price, outputMicroUsdPerMillion: "0002" },
    { ...price, inputMicroUsdPerMillion: "0", outputMicroUsdPerMillion: "0" },
  ];
  for (const snapshot of invalid) {
    assert.throws(() => quoteNativeTextUsage(snapshot as never, context, openaiFixture));
  }
  for (const reservedMicroUsd of ["161", "0", "-1", "1.1", "NaN", "00162"]) {
    assert.throws(() =>
      quoteNativeTextUsage(price, { ...context, reservedMicroUsd }, openaiFixture),
    );
  }
  assert.throws(() =>
    quoteNativeTextUsage(price, { ...context, jobId: "not-a-uuid" }, openaiFixture),
  );
  assert.throws(() => quoteNativeTextUsage(price, context, { ...openaiFixture, usage: null }));
});

test("zero measured tokens produce a zero quote without granting payment approval", () => {
  const usage = {
    ...openaiFixture,
    usage: {
      ...openaiFixture.usage,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const result = quoteNativeTextUsage(price, { ...context, reservedMicroUsd: "0" }, usage);
  assert.equal(result.costMicroUsd, "0");
  assert.equal(result.approvedForPayment, false);
  assert.equal(result.persistent, false);
});
