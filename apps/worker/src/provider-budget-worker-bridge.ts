import type { Pool, PoolClient } from "pg";
import { quoteNativeTextUsage } from "./provider-priced-usage.js";
import type { ProviderUsageAdmission } from "./provider-usage-admission.js";
import { providerUsageEvidenceStore } from "./provider-usage-evidence-store.js";
import type { NativeProvider } from "./provider-native-usage.js";

/**
 * #230: a dormant SQL-only worker bridge. No API transport is imported or
 * constructed; the currently deployed worker never imports this module.
 * Explicit opt-in is required even for isolated test fixtures.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST = /^[A-Za-z0-9_-]{12,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VERSION = /^[A-Za-z0-9_-]{12,80}$/;
const MONEY = /^(0|[1-9][0-9]{0,14})$/;
const MAX_RATE = 1_000_000_000_000n;

export type BudgetReplayRequest = Readonly<{
  jobId: string;
  requestId: string;
  provider: NativeProvider;
  model: string;
  priceSnapshotId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}>;

export type BudgetWorkerFault =
  | "response_missing"
  | "response_invalid"
  | "quote_over_reservation"
  | "persistence_failed"
  | "settlement_unconfirmed";

interface SqlProjection {
  reservation_id: string;
  job_id: string;
  request_id: string;
  provider: string;
  model: string;
  price_version: string;
  currency: string;
  reserved_micro_usd: string;
  max_input_tokens: string;
  max_output_tokens: string;
  input_micro_usd_per_million: string;
  cached_input_micro_usd_per_million: string;
  output_micro_usd_per_million: string;
}

type VerifiedProjection = Readonly<SqlProjection>;

function requireReservationRequest(value: BudgetReplayRequest): void {
  if (
    !value ||
    !UUID.test(value.jobId) ||
    !REQUEST.test(value.requestId) ||
    !["openai", "google_gemini"].includes(value.provider) ||
    !MODEL.test(value.model) ||
    !UUID.test(value.priceSnapshotId) ||
    !Number.isSafeInteger(value.maxInputTokens) ||
    !Number.isSafeInteger(value.maxOutputTokens) ||
    value.maxInputTokens < 1 ||
    value.maxOutputTokens < 1 ||
    value.maxInputTokens > 100_000_000 ||
    value.maxOutputTokens > 100_000_000
  ) {
    throw new Error("Provider budget request invalid");
  }
}

function decimal(value: unknown, limit: bigint): string {
  if (typeof value !== "string" || !MONEY.test(value) || BigInt(value) > limit) {
    throw new Error("Provider budget projection unavailable");
  }
  return value;
}

function verifyProjection(input: BudgetReplayRequest, id: string, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Provider budget projection unavailable");
  }
  const row = raw as Record<string, unknown>;
  if (
    Object.keys(row).length !== 13 ||
    row.reservation_id !== id ||
    row.job_id !== input.jobId ||
    row.request_id !== input.requestId ||
    row.provider !== input.provider ||
    row.model !== input.model ||
    row.currency !== "USD" ||
    typeof row.price_version !== "string" ||
    !VERSION.test(row.price_version)
  ) {
    throw new Error("Provider budget projection unavailable");
  }
  const maxInput = decimal(row.max_input_tokens, 100_000_000n);
  const maxOutput = decimal(row.max_output_tokens, 100_000_000n);
  if (
    BigInt(maxInput) !== BigInt(input.maxInputTokens) ||
    BigInt(maxOutput) !== BigInt(input.maxOutputTokens)
  ) {
    throw new Error("Provider budget projection unavailable");
  }
  decimal(row.reserved_micro_usd, 999_999_999_999_999n);
  decimal(row.input_micro_usd_per_million, MAX_RATE);
  decimal(row.cached_input_micro_usd_per_million, MAX_RATE);
  decimal(row.output_micro_usd_per_million, MAX_RATE);
  if (
    BigInt(row.cached_input_micro_usd_per_million as string) >
    BigInt(row.input_micro_usd_per_million as string)
  ) {
    throw new Error("Provider budget projection unavailable");
  }
  return Object.freeze(row as unknown as VerifiedProjection);
}

export function dormantProviderBudgetBridge(
  db: Pick<Pool, "query" | "connect">,
  enabled = false,
) {
  if (enabled !== true) throw new Error("Provider budget worker bridge disabled");
  return {
    async reserve(input: BudgetReplayRequest): Promise<string> {
      requireReservationRequest(input);
      try {
        const result = await db.query<{ id: string }>(
          "SELECT vns.reserve_provider_live_budget(" +
            "$1::uuid,$2::text,$3::text,$4::text,$5::uuid," +
            "$6::bigint,$7::bigint)::text AS id",
          [
            input.jobId,
            input.provider,
            input.model,
            input.requestId,
            input.priceSnapshotId,
            String(input.maxInputTokens),
            String(input.maxOutputTokens),
          ],
        );
        const id = result.rows[0]?.id;
        if (result.rows.length !== 1 || !id || !UUID.test(id)) {
          throw new Error("Invalid budget reservation");
        }
        return id;
      } catch {
        throw new Error("Provider budget reservation unavailable");
      }
    },

    async projection(input: BudgetReplayRequest, id: string) {
      requireReservationRequest(input);
      if (!UUID.test(id)) throw new Error("Provider budget projection unavailable");
      try {
        const result = await db.query<SqlProjection>(
          "SELECT * FROM vns.get_provider_live_reservation($1::uuid)",
          [id],
        );
        if (result.rows.length !== 1) {
          throw new Error("Missing SQL projection");
        }
        return verifyProjection(input, id, result.rows[0]);
      } catch {
        throw new Error("Provider budget projection unavailable");
      }
    },

    async halt(id: string, reason: BudgetWorkerFault): Promise<void> {
      if (!UUID.test(id)) throw new Error("Provider emergency halt unavailable");
      try {
        const result = await db.query<{ halted: boolean }>(
          "SELECT vns.halt_provider_live_budget($1::uuid,$2::text) AS halted",
          [id, reason],
        );
        if (result.rows.length !== 1 || result.rows[0]?.halted !== true) {
          throw new Error("Budget halt unconfirmed");
        }
      } catch {
        throw new Error("Provider emergency halt unavailable");
      }
    },

    async settle(
      id: string,
      usage: ProviderUsageAdmission,
    ): Promise<"settled" | "halted"> {
      if (!UUID.test(id)) throw new Error("Provider budget settlement unavailable");
      let connection: PoolClient | undefined;
      let inTransaction = false;
      try {
        connection = await db.connect();
        await connection.query("BEGIN");
        inTransaction = true;
        const receipt = await providerUsageEvidenceStore(connection, true).record(usage);
        const result = await connection.query<{ status: string }>(
          "SELECT vns.settle_provider_live_budget($1::uuid,$2::uuid) AS status",
          [id, receipt.receiptId],
        );
        const status = result.rows[0]?.status;
        if (
          result.rows.length !== 1 ||
          (status !== "settled" && status !== "halted")
        ) {
          throw new Error("Unexpected settlement result");
        }
        await connection.query("COMMIT");
        inTransaction = false;
        return status;
      } catch {
        if (inTransaction && connection) {
          await connection.query("ROLLBACK").catch(() => undefined);
        }
        throw new Error("Provider budget settlement unavailable");
      } finally {
        connection?.release();
      }
    },
  };
}

/**
 * Accepts a previously captured, trusted provider response only. This is NOT
 * a dispatch function: no network call, API key or provider SDK is present.
 * The SQL ledger remains disabled until separately authorized and migrated.
 */
export async function replayProviderBudgetFixture(
  bridge: ReturnType<typeof dormantProviderBudgetBridge>,
  input: BudgetReplayRequest,
  response: unknown,
): Promise<Readonly<{ reservationId: string; costMicroUsd: string; reconciled: true }>> {
  requireReservationRequest(input);
  const reservationId = await bridge.reserve(input);

  // Any uncertainty after reservation must trigger a durable project-wide
  // stop; a failed halt is itself a hard failure, never proof of safety.
  async function fail(reason: BudgetWorkerFault): Promise<never> {
    await bridge.halt(reservationId, reason);
    throw new Error("Provider budget review required");
  }

  let projection: VerifiedProjection;
  try {
    projection = await bridge.projection(input, reservationId);
  } catch {
    return fail("settlement_unconfirmed");
  }

  if (response === null || response === undefined) return fail("response_missing");
  let usage: ProviderUsageAdmission;
  try {
    usage = quoteNativeTextUsage(
      {
        provider: input.provider,
        model: input.model,
        priceVersion: projection.price_version,
        currency: "USD",
        inputMicroUsdPerMillion: projection.input_micro_usd_per_million,
        cachedInputMicroUsdPerMillion: projection.cached_input_micro_usd_per_million,
        outputMicroUsdPerMillion: projection.output_micro_usd_per_million,
      },
      {
        jobId: projection.job_id,
        requestId: projection.request_id,
        reservedMicroUsd: projection.reserved_micro_usd,
      },
      response,
    );
  } catch (error) {
    return fail(
      error instanceof Error && error.message === "Provider reservation exceeded"
        ? "quote_over_reservation"
        : "response_invalid",
    );
  }
  if (
    usage.inputTokens > input.maxInputTokens ||
    usage.outputTokens > input.maxOutputTokens
  ) {
    return fail("quote_over_reservation");
  }

  let result: "settled" | "halted";
  try {
    result = await bridge.settle(reservationId, usage);
  } catch {
    return fail("persistence_failed");
  }
  if (result !== "settled") throw new Error("Provider budget review required");
  return Object.freeze({
    reservationId,
    costMicroUsd: usage.costMicroUsd,
    reconciled: true as const,
  });
}
