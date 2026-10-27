/**
 * #230: fail-closed native text-only usage extraction.
 *
 * Pure, dormant conversion; no SDK, network, credentials, runtime dispatch or
 * billable execution. The trusted caller must verify the transport response
 * came from the named vendor; never accept arbitrary model-produced JSON.
 */
export type NativeProvider = "openai" | "google_gemini";

export type NativeTextUsage = Readonly<{
  provider: NativeProvider;
  model: string;
  responseId: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  source: "provider_response";
  persistent: false;
  approvedForPayment: false;
}>;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const RESPONSE_ID = /^[A-Za-z0-9_-]{12,80}$/;

function invalid(): never {
  // Do not echo raw responses, prompts, transport headers or credentials.
  throw new Error("Invalid native provider usage");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function tokens(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 100_000_000
  ) {
    invalid();
  }
  return value as number;
}

function optionalTokens(row: Record<string, unknown>, key: string): number {
  return Object.hasOwn(row, key) ? tokens(row[key]) : 0;
}

function textOnlyGeminiModalities(row: Record<string, unknown>): void {
  for (const key of [
    "promptTokensDetails",
    "cacheTokensDetails",
    "candidatesTokensDetails",
    "toolUsePromptTokensDetails",
  ]) {
    const details = row[key];
    if (details === undefined) continue;
    if (!Array.isArray(details)) invalid();
    for (const item of details) {
      const modality = object(item).modality;
      if (modality !== "TEXT") invalid();
      // Counts in arrays are advisory breakdowns, not independent billable
      // totals; still fail if a reported count is malformed.
      tokens(object(item).tokenCount);
    }
  }
}

/**
 * Only settled, text-only, non-tool responses may pass into the current
 * USD-per-million-text-token model. An incomplete/blocked/partially
 * streamed response must retain its reservation for operator review.
 *
 * OpenAI Responses API: usage.input_tokens includes cached tokens and
 * usage.output_tokens includes reasoning tokens.
 * Gemini generateContent: promptTokenCount includes cache; thinking tokens
 * are added to candidatesTokenCount for total output accounting. Tool usage
 * and non-text modalities require separately reviewed pricing contracts.
 */
export function extractNativeTextUsage(
  provider: NativeProvider,
  expectedModel: string,
  nativeResponse: unknown,
): NativeTextUsage {
  if (!MODEL.test(expectedModel)) invalid();
  const row = object(nativeResponse);
  let responseId: string;
  let input: number;
  let cached: number;
  let output: number;
  let reasoning: number;

  if (provider === "openai") {
    if (
      row.object !== "response" ||
      row.status !== "completed" ||
      row.model !== expectedModel ||
      row.error !== null ||
      row.incomplete_details !== null
    ) {
      invalid();
    }
    responseId = row.id as string;
    const usage = object(row.usage);
    input = tokens(usage.input_tokens);
    output = tokens(usage.output_tokens);
    const total = tokens(usage.total_tokens);
    cached = tokens(object(usage.input_tokens_details).cached_tokens);
    reasoning = optionalTokens(object(usage.output_tokens_details), "reasoning_tokens");
    if (cached > input || reasoning > output || input + output !== total) invalid();
    // Even a completed response can include tool calls, whose vendor pricing
    // is not represented by the text-only price snapshot.
    if (Array.isArray(row.output)) {
      for (const item of row.output) {
        if (!["message", "reasoning"].includes(object(item).type as string)) invalid();
      }
    }
  } else if (provider === "google_gemini") {
    if (row.modelVersion !== expectedModel) invalid();
    responseId = row.responseId as string;
    const candidates = row.candidates;
    if (
      !Array.isArray(candidates) ||
      candidates.length < 1 ||
      candidates.length > 8 ||
      !candidates.every((candidate) => object(candidate).finishReason === "STOP")
    ) {
      invalid();
    }
    if (row.promptFeedback !== undefined) {
      const blocked = object(row.promptFeedback).blockReason;
      if (blocked !== undefined && blocked !== "BLOCK_REASON_UNSPECIFIED") invalid();
    }
    const usage = object(row.usageMetadata);
    input = tokens(usage.promptTokenCount);
    cached = optionalTokens(usage, "cachedContentTokenCount");
    const candidateTokens = tokens(usage.candidatesTokenCount);
    reasoning = optionalTokens(usage, "thoughtsTokenCount");
    const toolTokens = optionalTokens(usage, "toolUsePromptTokenCount");
    const total = tokens(usage.totalTokenCount);
    // Not silently assigning an unknown tool-use category to text pricing.
    if (toolTokens !== 0) invalid();
    output = candidateTokens + reasoning;
    if (cached > input || input + output !== total) invalid();
    textOnlyGeminiModalities(usage);
  } else {
    invalid();
  }

  if (typeof responseId !== "string" || !RESPONSE_ID.test(responseId)) invalid();
  return Object.freeze({
    provider,
    model: expectedModel,
    responseId,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    source: "provider_response" as const,
    persistent: false as const,
    approvedForPayment: false as const,
  });
}
