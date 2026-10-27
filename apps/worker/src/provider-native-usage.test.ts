import assert from "node:assert/strict";
import test from "node:test";
import { extractNativeTextUsage } from "./provider-native-usage.js";

export const openaiFixture = Object.freeze({
  object: "response",
  id: "resp_native_openai_000001",
  model: "operator-chosen-model",
  status: "completed",
  error: null,
  incomplete_details: null,
  output: [{ type: "message" }],
  usage: {
    input_tokens: 100,
    output_tokens: 40,
    total_tokens: 140,
    input_tokens_details: { cached_tokens: 25 },
    output_tokens_details: { reasoning_tokens: 5 },
  },
});

export const geminiFixture = Object.freeze({
  responseId: "gemini_native_response_01",
  modelVersion: "operator-chosen-gemini",
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: {
    promptTokenCount: 100,
    cachedContentTokenCount: 20,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 3,
    totalTokenCount: 113,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 100 }],
    candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 10 }],
  },
});

test("OpenAI Responses usage: cached and reasoning tokens stay within reported totals", () => {
  assert.deepEqual(extractNativeTextUsage("openai", "operator-chosen-model", openaiFixture), {
    provider: "openai",
    model: "operator-chosen-model",
    responseId: "resp_native_openai_000001",
    inputTokens: 100,
    cachedInputTokens: 25,
    outputTokens: 40,
    reasoningOutputTokens: 5,
    source: "provider_response",
    persistent: false,
    approvedForPayment: false,
  });
  assert.ok(
    Object.isFrozen(extractNativeTextUsage("openai", "operator-chosen-model", openaiFixture)),
  );
});

test("Gemini usage: thinking tokens add to candidate output and cached prompt is included", () => {
  assert.deepEqual(extractNativeTextUsage("google_gemini", "operator-chosen-gemini", geminiFixture), {

    provider: "google_gemini",
    model: "operator-chosen-gemini",
    responseId: "gemini_native_response_01",
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 13,
    reasoningOutputTokens: 3,
    source: "provider_response",
    persistent: false,
    approvedForPayment: false,
  });
});

test("OpenAI missing, aborted, contradictory, unbounded and non-text usage fails closed", () => {
  const failures: unknown[] = [
    null,
    {},
    { ...openaiFixture, status: "incomplete" },
    { ...openaiFixture, error: { type: "some_error" } },
    { ...openaiFixture, incomplete_details: { reason: "max_output_tokens" } },
    { ...openaiFixture, model: "different" },
    { ...openaiFixture, id: "short" },
    { ...openaiFixture, output: [{ type: "function_call" }] },
    { ...openaiFixture, usage: null },
    { ...openaiFixture, usage: { ...openaiFixture.usage, total_tokens: 139 } },
    { ...openaiFixture, usage: { ...openaiFixture.usage, input_tokens: -1 } },
    { ...openaiFixture, usage: { ...openaiFixture.usage, input_tokens: 2.25 } },
    { ...openaiFixture, usage: { ...openaiFixture.usage, output_tokens: 100_000_001 } },
    { ...openaiFixture, usage: { ...openaiFixture.usage, input_tokens_details: null } },
    {
      ...openaiFixture,
      usage: { ...openaiFixture.usage, input_tokens_details: { cached_tokens: 101 } },
    },
    {
      ...openaiFixture,
      usage: { ...openaiFixture.usage, output_tokens_details: { reasoning_tokens: 41 } },
    },
  ];
  for (const native of failures) {
    assert.throws(
      () => extractNativeTextUsage("openai", "operator-chosen-model", native),
      (error: Error) => error.message === "Invalid native provider usage",
    );
  }
});

test("Gemini blocks incomplete, non-text, tool, malformed usage and mismatched models", () => {
  const failures: unknown[] = [
    { ...geminiFixture, responseId: "" },
    { ...geminiFixture, modelVersion: "different" },
    { ...geminiFixture, candidates: [] },
    { ...geminiFixture, candidates: [{ finishReason: "MAX_TOKENS" }] },
    { ...geminiFixture, candidates: [{ finishReason: "SAFETY" }] },
    { ...geminiFixture, promptFeedback: { blockReason: "SAFETY" } },
    { ...geminiFixture, usageMetadata: undefined },
    { ...geminiFixture, usageMetadata: { ...geminiFixture.usageMetadata, totalTokenCount: 112 } },
    {
      ...geminiFixture,
      usageMetadata: { ...geminiFixture.usageMetadata, toolUsePromptTokenCount: 2 },
    },
    {
      ...geminiFixture,
      usageMetadata: { ...geminiFixture.usageMetadata, cachedContentTokenCount: 101 },
    },
    {
      ...geminiFixture,
      usageMetadata: {
        ...geminiFixture.usageMetadata,
        promptTokensDetails: [{ modality: "IMAGE", tokenCount: 100 }],
      },
    },
    {
      ...geminiFixture,
      usageMetadata: {
        ...geminiFixture.usageMetadata,
        candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 10 }],
      },
    },
    {
      ...geminiFixture,
      usageMetadata: { ...geminiFixture.usageMetadata, promptTokensDetails: null },
    },
  ];
  for (const native of failures) {
    assert.throws(
      () => extractNativeTextUsage("google_gemini", "operator-chosen-gemini", native),
      /Invalid native provider usage/,
    );
  }
});

test("invalid model, response IDs and unexpected provider cannot be admitted", () => {
  assert.throws(() => extractNativeTextUsage("openai", "../../bad", openaiFixture));
  assert.throws(() =>
    extractNativeTextUsage("unknown" as never, "operator-chosen-model", openaiFixture),
  );
  assert.throws(
    () =>
      extractNativeTextUsage("openai", "operator-chosen-model", {
        ...openaiFixture,
        id: "resp\nfake",
      }),
  );
});
