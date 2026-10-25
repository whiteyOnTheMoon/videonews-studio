import type { Pool } from "pg";

// Dormant CI-only integration. No running service imports this module.
// Real provider/billing data require a separately approved new migration.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REQUEST = /^[A-Za-z0-9_-]{12,80}$/;
const KEYS = [
  "jobId", "requestId", "provider", "model", "inputTokens",
  "outputTokens", "inputMicroUsdPerMillion", "outputMicroUsdPerMillion",
] as const;

export interface SyntheticUsage {
  jobId: string;
  requestId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
}

export interface SyntheticUsageReceipt {
  receiptId: string;
  estimatedCostMicroUsd: string;
  estimated: true;
  currency: "USD";
}

export interface SyntheticUsageTotals {
  jobId: string;
  requests: string;
  inputTokens: string;
  outputTokens: string;
  estimatedCostMicroUsd: string;
  estimated: true;
  currency: "USD";
}

function bounded(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= maximum;
}

export function validateSyntheticUsage(value: unknown): SyntheticUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid synthetic usage receipt");
  }
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== KEYS.length ||
    !KEYS.every((key) => Object.hasOwn(data, key)) ||
    typeof data.jobId !== "string" || !UUID.test(data.jobId) ||
    typeof data.requestId !== "string" || !REQUEST.test(data.requestId) ||
    typeof data.provider !== "string" || !NAME.test(data.provider) ||
    typeof data.model !== "string" || !NAME.test(data.model) ||
    !bounded(data.inputTokens, 100_000_000) ||
    !bounded(data.outputTokens, 100_000_000) ||
    !bounded(data.inputMicroUsdPerMillion, 1_000_000_000_000) ||
    !bounded(data.outputMicroUsdPerMillion, 1_000_000_000_000)
  ) {
    throw new Error("Invalid synthetic usage receipt");
  }
  return data as unknown as SyntheticUsage;
}

export function estimateMicroUsd(event: SyntheticUsage): string {
  const data = validateSyntheticUsage(event);
  const numerator =
    BigInt(data.inputTokens) * BigInt(data.inputMicroUsdPerMillion) +
    BigInt(data.outputTokens) * BigInt(data.outputMicroUsdPerMillion);
  return ((numerator + 999_999n) / 1_000_000n).toString();
}

export function syntheticUsageStore(pool: Pool, enabled: boolean) {
  if (enabled !== true) {
    throw new Error("Synthetic receipt recording must be explicitly enabled");
  }
  return {
    async record(event: unknown): Promise<SyntheticUsageReceipt> {
      const data = validateSyntheticUsage(event);
      const amount = estimateMicroUsd(data);
      try {
        const result = await pool.query<{ id: string }>(
          "SELECT vns.record_synthetic_token_usage(" +
          "$1::uuid,$2::text,$3::text,$4::text," +
          "$5::bigint,$6::bigint,$7::bigint,$8::bigint)::text AS id",
          [
            data.jobId, data.provider, data.model, data.requestId,
            String(data.inputTokens), String(data.outputTokens),
            String(data.inputMicroUsdPerMillion),
            String(data.outputMicroUsdPerMillion),
          ],
        );
        const receiptId = result.rows[0]?.id;
        if (result.rows.length !== 1 || typeof receiptId !== "string" ||
            !UUID.test(receiptId)) {
          throw new Error("Invalid database token receipt");
        }
        return {
          receiptId, estimatedCostMicroUsd: amount, estimated: true, currency: "USD",
        };
      } catch {
        throw new Error("Synthetic token receipt unavailable");
      }
    },
    async summarize(jobId: string): Promise<SyntheticUsageTotals> {
      if (!UUID.test(jobId)) throw new Error("Invalid synthetic job ID");
      try {
        const result = await pool.query<{
          requests: string;
          input_tokens: string;
          output_tokens: string;
          estimated_cost_micro_usd: string;
        }>(
          "SELECT count(*)::text AS requests," +
          "coalesce(sum(input_tokens),0)::text AS input_tokens," +
          "coalesce(sum(output_tokens),0)::text AS output_tokens," +
          "coalesce(sum(estimated_cost_micro_usd),0)::text AS estimated_cost_micro_usd " +
          "FROM vns.job_token_usage WHERE job_id=$1::uuid",
          [jobId],
        );
        const row = result.rows[0];
        if (result.rows.length !== 1 || !row ||
            ![row.requests, row.input_tokens, row.output_tokens,
              row.estimated_cost_micro_usd].every((field) =>
              typeof field === "string" && /^\d{1,40}$/.test(field))) {
          throw new Error("Invalid database token summary");
        }
        return {
          jobId,
          requests: row.requests,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          estimatedCostMicroUsd: row.estimated_cost_micro_usd,
          estimated: true,
          currency: "USD",
        };
      } catch {
        throw new Error("Synthetic token summary unavailable");
      }
    },
  };
}
