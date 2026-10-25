import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMockOpenAiResponse } from "./mock-openai-response.js";
import { TEXT_STAGES } from "./ai-provider-policy.js";
import { estimateMicroUsd, validateSyntheticUsage } from "./token-usage.js";

const JOB = "b274db39-cfd5-46bf-8438-27557b89201a";
const REQ = "ci_mock_req_000001";
const RESPONSE_ID = "resp_ci_mock_000001";

function request(stage: keyof typeof TEXT_STAGES = "script_draft") {
  const policy = TEXT_STAGES[stage];
  return {
    jobId: JOB,
    requestId: REQ,
    stage,
    model: policy.model,
    language: "en",
    maxInputTokens: policy.maxInputTokens,
    maxOutputTokens: policy.maxOutputTokens,
  };
}
function fixture(model: string = TEXT_STAGES.script_draft.model) {
  return {
    id: RESPONSE_ID,
    object: "response",
    status: "completed",
    model,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "A clearly synthetic English news explanation, pending editorial review.",
          },
        ],
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
  };
}

test("synthetic OpenAI-shaped fixture never implies payment, truth or publication", () => {
  const output = evaluateMockOpenAiResponse(request(), fixture());
  assert.equal(output.fixtureText, fixture().output[0]?.content[0]?.text);
  assert.deepEqual(
    [output.estimated, output.simulated, output.requiresEditorialReview],
    [true, true, true],
  );
  assert.equal(output.approvedForPublication, false);
  assert.equal(output.spendApproved, false);
  assert.equal(output.networkAllowed, false);
  assert.equal(output.language, "en");
  assert.equal(output.estimatedCostMicroUsd, "7000");
  assert.deepEqual(output.syntheticUsage, {
    jobId: JOB,
    requestId: REQ,
    provider: "openai",
    model: "gpt-6.1-sol",
    inputTokens: 1000,
    outputTokens: 500,
    inputMicroUsdPerMillion: 2_000_000,
    outputMicroUsdPerMillion: 10_000_000,
  });
  assert.deepEqual(validateSyntheticUsage(output.syntheticUsage), output.syntheticUsage);
  assert.equal(estimateMicroUsd(output.syntheticUsage), output.estimatedCostMicroUsd);
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.syntheticUsage));
});

test("all three stages accept matching models and rates with no text processing API", () => {
  for (const stage of ["topic_triage", "script_draft", "fact_audit"] as const) {
    const input = request(stage);
    const response = fixture(input.model);
    const result = evaluateMockOpenAiResponse(input, response);
    assert.equal(result.stage, stage);
    assert.equal(result.model, input.model);
    assert.equal(result.requiresEditorialReview, true);
    assert.ok(BigInt(result.estimatedCostMicroUsd) >= 0n);
  }
});

test("strict simulated request identity, stage, language, ceilings and secret rejection", () => {
  const baseline = request();
  for (const altered of [
    null,
    [],
    {},
    { ...baseline, apiKey: "should never arrive" },
    { ...baseline, prompt: "source document" },
    { ...baseline, sourceUrl: "https://example.invalid" },
    { ...baseline, jobId: "invalid" },
    { ...baseline, requestId: "short" },
    { ...baseline, stage: "__proto__" },
    { ...baseline, stage: "wrong_stage" },
    { ...baseline, language: "de" },
    { ...baseline, model: TEXT_STAGES.topic_triage.model },
    { ...baseline, maxInputTokens: 20_001 },
    { ...baseline, maxInputTokens: 0 },
    { ...baseline, maxOutputTokens: -1 },
  ]) {
    assert.throws(() => evaluateMockOpenAiResponse(altered, fixture()), /Invalid|exceeds|Rejected/);
  }
});

test("unknown provider features, incomplete responses and extra output are denied", () => {
  const response = fixture();
  for (const altered of [
    null,
    [],
    {},
    { ...response, id: "missing" },
    { ...response, model: "other_model" },
    { ...response, status: "incomplete" },
    { ...response, status: "failed" },
    { ...response, object: "chat.completion" },
    { ...response, tools: [] },
    { ...response, output: [] },
    { ...response, output: [...response.output, ...response.output] },
    { ...response, output: [{ ...response.output[0], type: "web_search_call" }] },
    { ...response, output: [{ ...response.output[0], role: "tool" }] },
    { ...response, output: [{ ...response.output[0], content: [] }] },
    {
      ...response,
      output: [{ ...response.output[0], content: [{ type: "refusal", text: "declined" }] }],
    },
    {
      ...response,
      output: [{ ...response.output[0], content: [{ type: "output_text", text: "" }] }],
    },
    {
      ...response,
      output: [{ ...response.output[0], content: [{ type: "output_text", text: "A message\n" }] }],
    },
    {
      ...response,
      output: [
        { ...response.output[0], content: [{ type: "output_text", text: "Bad\u0000text data" }] },
      ],
    },
    {
      ...response,
      output: [
        {
          ...response.output[0],
          content: [{ ...response.output[0]?.content[0], annotations: [] }],
        },
      ],
    },
  ]) {
    assert.throws(() => evaluateMockOpenAiResponse(request(), altered), /Invalid|Rejected/);
  }
});

test("missing, contradictory and noninteger usage fails closed", () => {
  const response = fixture();
  for (const usage of [
    null,
    {},
    { input_tokens: 1, output_tokens: 1, total_tokens: 999 },
    { input_tokens: -1, output_tokens: 1, total_tokens: 0 },
    { input_tokens: 20_001, output_tokens: 1, total_tokens: 20_002 },
    { input_tokens: 1, output_tokens: 5_001, total_tokens: 5_002 },
    { input_tokens: 1, output_tokens: 0.1, total_tokens: 1.1 },
    { input_tokens: 1, output_tokens: true, total_tokens: 2 },
    { input_tokens: 1, output_tokens: 1, total_tokens: "2" },
    { input_tokens: 1, output_tokens: 1, total_tokens: 2, cached_tokens: 1 },
  ]) {
    assert.throws(
      () => evaluateMockOpenAiResponse(request(), { ...response, usage }),
      /Invalid|Rejected/,
    );
  }
});

test("deterministic repeat produces identical receipt data, never persists it", () => {
  const first = evaluateMockOpenAiResponse(request(), fixture());
  const second = evaluateMockOpenAiResponse(request(), fixture());
  assert.deepEqual(first, second);
  assert.equal(first.requestId, REQ);
  assert.equal(first.responseId, RESPONSE_ID);
  assert.ok(!("billed" in first));
  assert.ok(!("verified" in first));
});
