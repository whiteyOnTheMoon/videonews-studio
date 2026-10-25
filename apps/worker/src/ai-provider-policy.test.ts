import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultOfflineEnglishNewsPlan,
  EDITORIAL_LANGUAGE,
  proposeOfflineJobBudget,
  proposeOfflineTextReservation,
  PROVIDER_POLICY_DATE,
  PROPOSED_DAILY_CAP_MICRO_USD,
  PROPOSED_JOB_CAP_MICRO_USD,
  TEXT_STAGES,
  TTS_CANDIDATE,
} from "./ai-provider-policy.js";

function fullStage(stage: keyof typeof TEXT_STAGES) {
  const entry = TEXT_STAGES[stage];
  return {
    stage,
    model: entry.model,
    language: "en",
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
  };
}

test("offline English news profile chooses verified provider names without any runtime execution", () => {
  const plan = defaultOfflineEnglishNewsPlan();
  assert.equal(EDITORIAL_LANGUAGE, "en");
  assert.equal(PROVIDER_POLICY_DATE, "2026-10-25");
  assert.deepEqual(
    plan.requests.map((item) => [item.stage, item.provider, item.model]),
    [
      ["topic_triage", "openai", "gpt-6-luna"],
      ["script_draft", "openai", "gpt-6.1-sol"],
      ["fact_audit", "openai", "gpt-6.1-sol"],
    ],
  );
  assert.equal(plan.networkAllowed, false);
  assert.equal(plan.spendApproved, false);
  assert.equal(plan.estimated, true);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.requests));
  assert.ok(plan.requests.every((item) => Object.isFrozen(item)));
  assert.ok(plan.requests.every((item) => !("apiKey" in item)));
  assert.equal(TTS_CANDIDATE.provider, "google_gemini");
  assert.equal(TTS_CANDIDATE.model, "gemini-3.8-flash-tts");
  assert.equal(TTS_CANDIDATE.language, "en");
  assert.equal(TTS_CANDIDATE.priceVerified, false);
  assert.equal(TTS_CANDIDATE.audioCostAccountingReady, false);
  assert.equal(TTS_CANDIDATE.executionAllowed, false);
});

test("integer cost ceilings are transparent estimates, not spending authorizations", () => {
  const output = defaultOfflineEnglishNewsPlan();
  assert.deepEqual(
    output.requests.map((item) => item.estimatedWorstCaseMicroUsd),
    ["750", "90000", "49000"],
  );
  assert.equal(output.estimatedWorstCaseMicroUsd, "139750");
  assert.equal(output.proposedJobCapMicroUsd, PROPOSED_JOB_CAP_MICRO_USD.toString());
  assert.equal(output.proposedDailyCapMicroUsd, PROPOSED_DAILY_CAP_MICRO_USD.toString());
  assert.ok(BigInt(output.estimatedWorstCaseMicroUsd) < PROPOSED_JOB_CAP_MICRO_USD);
  assert.ok(PROPOSED_JOB_CAP_MICRO_USD < PROPOSED_DAILY_CAP_MICRO_USD);
  assert.ok(
    output.requests.every((item) => item.estimated && !item.networkAllowed && !item.spendApproved),
  );
});

test("all request fields are exact and English-only; no prompts, secrets or URLs allowed", () => {
  const baseline = fullStage("topic_triage");
  for (const altered of [
    null,
    12,
    [],
    "not-a-request",
    { ...baseline, prompt: "Sensitive text" },
    { ...baseline, apiKey: "forbidden" },
    { ...baseline, sourceUrl: "https://example.invalid" },
    { ...baseline, stage: "__proto__" },
    { ...baseline, stage: "unknown" },
    { ...baseline, model: "gpt-6.1-sol" },
    { ...baseline, language: "de" },
    { ...baseline, maxInputTokens: 4_001 },
    { ...baseline, maxInputTokens: 0 },
    { ...baseline, maxOutputTokens: -1 },
    { ...baseline, maxOutputTokens: 1.5 },
    { ...baseline, maxOutputTokens: 2 ** 53 },
    { ...baseline, maxOutputTokens: "500" },
    { ...baseline, maxOutputTokens: true },
    { ...baseline, maxOutputTokens: null },
  ]) {
    assert.throws(() => proposeOfflineTextReservation(altered), /Invalid AI|exceeds offline/);
  }
});

test("lower input/output upper bounds always lower the exact reserved amount", () => {
  const big = proposeOfflineTextReservation(fullStage("script_draft"));
  const small = proposeOfflineTextReservation({
    ...fullStage("script_draft"),
    maxInputTokens: 1,
    maxOutputTokens: 1,
  });
  assert.equal(big.estimatedWorstCaseMicroUsd, "90000");
  assert.equal(small.estimatedWorstCaseMicroUsd, "12");
  assert.ok(BigInt(small.estimatedWorstCaseMicroUsd) < BigInt(big.estimatedWorstCaseMicroUsd));
});

test("missing, repeated, unexpected and malformed stages must fail closed", () => {
  const full = [fullStage("topic_triage"), fullStage("script_draft"), fullStage("fact_audit")];
  assert.equal(proposeOfflineJobBudget(full).estimatedWorstCaseMicroUsd, "139750");
  for (const altered of [
    [],
    full.slice(0, 2),
    [full[0], full[0], full[2]],
    [...full, full[1]],
    [full[1], full[1], full[1]],
    [full[0], { ...full[1], language: "de" }, full[2]],
    [full[0], { ...full[1], maxOutputTokens: 9_999 }, full[2]],
    {},
  ]) {
    assert.throws(() => proposeOfflineJobBudget(altered), /Offline|Invalid AI|exceeds offline/);
  }
});

test("no pricing or speech generation can be inferred from a TTS model name", () => {
  const tts = TTS_CANDIDATE;
  assert.equal(tts.voice, null);
  assert.equal(tts.executionAllowed, false);
  assert.equal(tts.audioCostAccountingReady, false);
  assert.ok(!("estimatedCostMicroUsd" in tts));
  assert.ok(!("key" in tts));
});
