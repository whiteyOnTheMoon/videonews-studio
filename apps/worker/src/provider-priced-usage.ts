import { admitReportedUsage, type ProviderUsageAdmission } from "./provider-usage-admission.js";
import { extractNativeTextUsage, type NativeProvider } from "./provider-native-usage.js";

/**
 * #230: dormant price-snapshot quote bound to a previously reserved request.
 * It cannot create a reservation, settle an invoice or authorize a network call.
 * Price snapshots MUST originate in a separately reviewed, versioned server
 * catalog. NEVER derive rates or price versions from provider responses,
 * browser input, model output or speculative published rates.
 */
export type TrustedTextPriceSnapshot = Readonly<{
  provider: NativeProvider;
  model: string;
  priceVersion: string;
  currency: "USD";
  inputMicroUsdPerMillion: string;
  cachedInputMicroUsdPerMillion: string;
  outputMicroUsdPerMillion: string;
}>;

export type ProviderTextQuoteContext = Readonly<{
  jobId: string;
  requestId: string;
  reservedMicroUsd: string;
}>;

const NONNEGATIVE = /^(0|[1-9][0-9]{0,14})$/;
const VERSION = /^[A-Za-z0-9_-]{12,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_COST = 999_999_999_999_999n;

function money(value: unknown): bigint {
  if (typeof value !== "string" || !NONNEGATIVE.test(value)) {
    throw new Error("Provider pricing unavailable");
  }
  return BigInt(value);
}

/**
 * Returns an UNPERSISTED, NOT PAYMENT-APPROVED evidence candidate.
 * Exceeding an existing reservation denies settlement; a coordinator must
 * retain that reservation and halt further provider dispatch.
 */
export function quoteNativeTextUsage(
  snapshot: TrustedTextPriceSnapshot,
  context: ProviderTextQuoteContext,
  nativeResponse: unknown,
): ProviderUsageAdmission {
  if (
    !snapshot ||
    (snapshot.provider !== "openai" && snapshot.provider !== "google_gemini") ||
    typeof snapshot.model !== "string" ||
    !MODEL.test(snapshot.model) ||
    typeof snapshot.priceVersion !== "string" ||
    !VERSION.test(snapshot.priceVersion) ||
    snapshot.currency !== "USD"
  ) {
    throw new Error("Provider pricing unavailable");
  }
  const inputRate = money(snapshot.inputMicroUsdPerMillion);
  const cacheRate = money(snapshot.cachedInputMicroUsdPerMillion);
  const outputRate = money(snapshot.outputMicroUsdPerMillion);
  // A cached token may never cost more than an uncached token in this
  // contract. Disallow entirely unpriced text generation.
  if (cacheRate > inputRate || inputRate + outputRate === 0n) {
    throw new Error("Provider pricing unavailable");
  }
  const reservation = money(context?.reservedMicroUsd);
  const usage = extractNativeTextUsage(snapshot.provider, snapshot.model, nativeResponse);
  const uncached = BigInt(usage.inputTokens - usage.cachedInputTokens);
  const numerator =
    uncached * inputRate +
    BigInt(usage.cachedInputTokens) * cacheRate +
    BigInt(usage.outputTokens) * outputRate;
  const cost = (numerator + 999_999n) / 1_000_000n;
  if (cost > reservation || cost > MAX_COST) {
    throw new Error("Provider reservation exceeded");
  }
  return admitReportedUsage({
    jobId: context.jobId,
    requestId: context.requestId,
    responseId: usage.responseId,
    provider: usage.provider,
    model: usage.model,
    priceVersion: snapshot.priceVersion,
    currency: "USD",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    costMicroUsd: cost.toString(),
  });
}
