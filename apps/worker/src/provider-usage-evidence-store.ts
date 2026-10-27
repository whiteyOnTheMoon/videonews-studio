import type { Pool } from "pg";
import { admitReportedUsage } from "./provider-usage-admission.js";

// Not imported by an active worker. The PostgreSQL function is deliberately
// granted only to a NOLOGIN role; no production writer identity exists yet.
// Only a separately trusted adapter may supply canonical provider metadata.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProviderEvidenceReceipt {
  receiptId: string;
  source: "provider_response";
  calculatedCostMicroUsd: string;
  currency: "USD";
  persistent: true;
  reconciled: false;
  approvedForPayment: false;
}

export function providerUsageEvidenceStore(pool: Pick<Pool, "query">, enabled: boolean) {
  if (enabled !== true) {
    throw new Error("Provider metering evidence store is disabled");
  }
  return {
    async record(value: unknown): Promise<ProviderEvidenceReceipt> {
      const usage = admitReportedUsage(value);
      let result: { rows: { id: string }[] };
      try {
        result = await pool.query<{ id: string }>(
          "SELECT vns.record_provider_usage_evidence(" +
            "$1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text," +
            "$7::bigint,$8::bigint,$9::bigint,$10::bigint)::text AS id",
          [
            usage.jobId,
            usage.provider,
            usage.model,
            usage.requestId,
            usage.responseId,
            usage.priceVersion,
            String(usage.inputTokens),
            String(usage.outputTokens),
            String(usage.cachedInputTokens),
            usage.costMicroUsd,
          ],
        );
      } catch {
        // Never reflect SQL diagnostics, connection URI, credentials or payload.
        throw new Error("Provider evidence persistence unavailable");
      }
      if (
        result.rows.length !== 1 ||
        typeof result.rows[0]?.id !== "string" ||
        !UUID.test(result.rows[0].id)
      ) {
        throw new Error("Invalid provider evidence receipt");
      }
      return Object.freeze({
        receiptId: result.rows[0].id,
        source: "provider_response" as const,
        calculatedCostMicroUsd: usage.costMicroUsd,
        currency: "USD" as const,
        persistent: true as const,
        reconciled: false as const,
        approvedForPayment: false as const,
      });
    },
  };
}
