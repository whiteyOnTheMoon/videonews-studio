import assert from "node:assert/strict";
import test from "node:test";
import { extractNativeTextUsage } from "./provider-native-usage.js";

import { geminiFixture, openaiFixture } from "./provider-native-usage-fixtures.js";

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
  const first = extractNativeTextUsage("openai", "operator-chosen-model", openaiFixture);
  assert.ok(Object.isFrozen(first));
});

test("Gemini usage: thinking tokens add to candidate output and cached prompt is included", () => {
  const usage = extractNativeTextUsage("google_gemini", "operator-chosen-gemini", geminiFixture);
  assert.deepEqual(usage, {
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
    {
      ...openaiFixture,
      output: [{ type: "message", content: [{ type: "output_audio", data: "x" }] }],
    },
    {
      ...openaiFixture,
      output: [{ type: "message", content: [{ type: "output_image", data: "x" }] }],
    },
    {
      ...openaiFixture,
      output: [{ type: "message", content: [{ type: "output_text", text: 5 }] }],
    },
    { ...openaiFixture, output: null },
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
    {
      ...geminiFixture,
      candidates: [
        { finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "audio/wav" } }] } },
      ],
    },
    {
      ...geminiFixture,
      candidates: [
        { finishReason: "STOP", content: { parts: [{ functionCall: { name: "unsafe" } }] } },
      ],
    },
    {
      ...geminiFixture,
      candidates: [
        { finishReason: "STOP", content: { parts: [{ text: "text", inlineData: "hidden" }] } },
      ],
    },
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
  const invalidProvider = () =>
    extractNativeTextUsage("unknown" as never, "operator-chosen-model", openaiFixture);
  assert.throws(invalidProvider);
  const forgedId = { ...openaiFixture, id: "resp\nfake" };
  assert.throws(() => extractNativeTextUsage("openai", "operator-chosen-model", forgedId));
});
