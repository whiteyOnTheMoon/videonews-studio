// P1-09 #230: pure admission boundary for provider-reported usage.
// No network, credentials, billing SDK, runtime activation or database writes.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_ID = /^[A-Za-z0-9_-]{12,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const COST = /^\\d{1,15}$/;
export type ProviderUsageAdmission = Readonly<{
  jobId: string;
  requestId: string;
  responseId: string;
  provider: "openai" | "google_gemini";
  model: string;
  priceVersion: string;
  currency: "USD";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costMicroUsd: string;
  source: "provider_response";
  approvedForPayment: false;
  persistent: false;
}>;
function integer(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid provider usage");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || !keys.every(k => Object.hasOwn(data, k)))
    throw Error("Invalid provider usage");
  return data;
}
/** Explicit canonical wrapper produced by a future trusted, separately approved provider adapter.
 * Never call this function on untrusted free-form AI output or infer missing usage. */
export function admitReportedUsage(value: unknown): ProviderUsageAdmission {
  const data = record(value, [
    "jobId", "requestId", "responseId", "provider", "model", "priceVersion",
    "currency", "inputTokens", "outputTokens", "cachedInputTokens", "costMicroUsd"
  ]);
  if (typeof data.jobId !== "string" || !UUID.test(data.jobId) ||
      typeof data.requestId !== "string" || !TOKEN_ID.test(data.requestId) ||
      typeof data.responseId !== "string" || !TOKEN_ID.test(data.responseId) ||
      (data.provider !== "openai" && data.provider !== "google_gemini") ||
      typeof data.model !== "string" || !MODEL.test(data.model) ||
      typeof data.priceVersion !== "string" || !TOKEN_ID.test(data.priceVersion) ||
      data.currency !== "USD" || !integer(data.inputTokens) ||
      !integer(data.outputTokens) || !integer(data.cachedInputTokens) ||
      data.cachedInputTokens > data.inputTokens ||
      typeof data.costMicroUsd !== "string" || !COST.test(data.costMicroUsd)) {
    throw Error("Invalid provider usage");
  }
  return Object.freeze({
    jobId: data.jobId, requestId: data.requestId, responseId: data.responseId,
    provider: data.provider, model: data.model, priceVersion: data.priceVersion,
    currency: "USD", inputTokens: data.inputTokens, outputTokens: data.outputTokens,
    cachedInputTokens: data.cachedInputTokens, costMicroUsd: data.costMicroUsd,
    source: "provider_response", approvedForPayment: false, persistent: false
  }) as ProviderUsageAdmission;
}
export function reconcileReportedUsage(
  reservedMicroUsd: string,
  actual: ProviderUsageAdmission,
): Readonly<{ state: "within_reservation" | "over_reservation"; deltaMicroUsd: string }> {
  if (!COST.test(reservedMicroUsd) || !COST.test(actual.costMicroUsd)) {
    throw Error("Invalid provider usage reservation");
  }
  const delta = BigInt(reservedMicroUsd) - BigInt(actual.costMicroUsd);
  return Object.freeze({
    state: delta >= 0n ? "within_reservation" : "over_reservation",
    deltaMicroUsd: delta.toString(),
  });
}
