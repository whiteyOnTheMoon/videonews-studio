import {
  proposeOfflineTextReservation,
  TEXT_STAGES,
  type OfflineTextReservation,
  type TextStage,
} from "./ai-provider-policy.js";
import { estimateMicroUsd, type SyntheticUsage } from "./token-usage.js";

// Deliberately pure: NO API SDK, fetch, environment reads, database, secrets or HTTP.
// These six-field fixtures are NOT a permissive live OpenAI response parser.
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{12,80}$/;
const RESPONSE_ID = /^resp_[A-Za-z0-9_-]{12,80}$/;

export interface MockOpenAiRequest {
  jobId: string;
  requestId: string;
  stage: TextStage;
  model: string;
  language: "en";
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface MockOpenAiResult {
  jobId: string;
  requestId: string;
  responseId: string;
  stage: TextStage;
  model: string;
  language: "en";
  fixtureText: string;
  syntheticUsage: SyntheticUsage;
  estimatedCostMicroUsd: string;
  estimated: true;
  simulated: true;
  requiresEditorialReview: true;
  approvedForPublication: false;
  networkAllowed: false;
  spendApproved: false;
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  ) {
    throw new Error("Invalid offline OpenAI fixture");
  }
  return value as Record<string, unknown>;
}

function boundedTokens(value: unknown, limit: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= limit;
}

function hasForbiddenControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index);
    if ((point < 32 && point !== 9 && point !== 10 && point !== 13) || point === 127) {
      return true;
    }
  }
  return false;
}

function validateRequest(input: unknown): {
  jobId: string;
  requestId: string;
  reservation: OfflineTextReservation;
} {
  const value = record(input, [
    "jobId",
    "requestId",
    "stage",
    "model",
    "language",
    "maxInputTokens",
    "maxOutputTokens",
  ]);
  if (
    typeof value.jobId !== "string" ||
    !JOB_ID.test(value.jobId) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID.test(value.requestId)
  ) {
    throw new Error("Invalid synthetic job identity");
  }
  const reservation = proposeOfflineTextReservation({
    stage: value.stage,
    model: value.model,
    language: value.language,
    maxInputTokens: value.maxInputTokens,
    maxOutputTokens: value.maxOutputTokens,
  });
  return { jobId: value.jobId, requestId: value.requestId, reservation };
}

/**
 * Exercise a Responses-API-LIKE completed, text-only fixture, not the real API.
 * Closed shape deliberately rejects tools, web search, refusal, partial output,
 * missing/mismatched token counters and unknown billable modalities.
 * This does not validate journalistic truth or authorize publishing.
 */
export function evaluateMockOpenAiResponse(
  input: unknown,
  simulatedResponse: unknown,
): MockOpenAiResult {
  const { jobId, requestId, reservation } = validateRequest(input);
  const response = record(simulatedResponse, [
    "id",
    "object",
    "status",
    "model",
    "output",
    "usage",
  ]);

  if (
    typeof response.id !== "string" ||
    !RESPONSE_ID.test(response.id) ||
    response.object !== "response" ||
    response.status !== "completed" ||
    response.model !== reservation.model ||
    !Array.isArray(response.output) ||
    response.output.length !== 1
  ) {
    throw new Error("Rejected offline OpenAI response");
  }

  const message = record(response.output[0], ["type", "role", "content"]);
  if (
    message.type !== "message" ||
    message.role !== "assistant" ||
    !Array.isArray(message.content) ||
    message.content.length !== 1
  ) {
    throw new Error("Rejected offline OpenAI message");
  }
  const content = record(message.content[0], ["type", "text"]);
  if (
    content.type !== "output_text" ||
    typeof content.text !== "string" ||
    content.text.length < 10 ||
    content.text.length > 20_000 ||
    content.text.trim() !== content.text ||
    hasForbiddenControlChars(content.text)
  ) {
    throw new Error("Rejected offline OpenAI text");
  }

  const usage = record(response.usage, ["input_tokens", "output_tokens", "total_tokens"]);
  if (
    !boundedTokens(usage.input_tokens, reservation.maxInputTokens) ||
    !boundedTokens(usage.output_tokens, reservation.maxOutputTokens) ||
    !Number.isSafeInteger(usage.total_tokens) ||
    usage.total_tokens !== usage.input_tokens + usage.output_tokens
  ) {
    throw new Error("Rejected offline OpenAI token usage");
  }

  const modelRates = TEXT_STAGES[reservation.stage];
  const syntheticUsage: SyntheticUsage = {
    jobId,
    requestId,
    provider: "openai",
    model: reservation.model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    inputMicroUsdPerMillion: Number(modelRates.inputMicroUsdPerMillion),
    outputMicroUsdPerMillion: Number(modelRates.outputMicroUsdPerMillion),
  };
  const estimatedCostMicroUsd = estimateMicroUsd(syntheticUsage);
  if (BigInt(estimatedCostMicroUsd) > BigInt(reservation.estimatedWorstCaseMicroUsd)) {
    throw new Error("Rejected offline OpenAI budget overrun");
  }
  return Object.freeze({
    jobId,
    requestId,
    responseId: response.id,
    stage: reservation.stage,
    model: reservation.model,
    language: reservation.language,
    fixtureText: content.text,
    syntheticUsage: Object.freeze(syntheticUsage),
    estimatedCostMicroUsd,
    estimated: true,
    simulated: true,
    requiresEditorialReview: true,
    approvedForPublication: false,
    networkAllowed: false,
    spendApproved: false,
  });
}
