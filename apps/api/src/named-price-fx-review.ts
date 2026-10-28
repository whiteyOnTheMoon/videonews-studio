import type { IncomingMessage, ServerResponse } from "node:http";
import { officialPriceReviewSource } from "@vns/shared";
import type { Pool } from "pg";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth, EditorIdentity } from "./editor-auth.js";
import { readLimitedJson, respond } from "./admin-provider-configuration.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VERSION = /^[A-Za-z0-9_-]{12,80}$/;
const UINT = /^(0|[1-9][0-9]{0,12})$/;
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const MAX = 1_000_000_000_000n;

export type NamedPriceReviewCommand =
  | Readonly<{
      action: "review_price";
      provider: "openai" | "google_gemini";
      model: string;
      priceVersion: string;
      inputMicroUsdPerMillion: string;
      cachedMicroUsdPerMillion: string;
      outputMicroUsdPerMillion: string;
      expiresAt: string;
      sourceReference: string;
    }>
  | Readonly<{
      action: "review_fx";
      microEurPerMicroUsdNanos: string;
      expiresAt: string;
      sourceReference: string;
    }>;

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
function integer(value: unknown, max: bigint): value is string {
  return typeof value === "string" && UINT.test(value) && BigInt(value) <= max;
}
function expires(value: unknown): value is string {
  return (
    typeof value === "string" &&
    DATE.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().startsWith(value.slice(0, 19))
  );
}

/** Exact contract; no budget enabling, endpoint selection, key or spending command. */
export function parseNamedPriceReview(input: unknown): NamedPriceReviewCommand | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  if (!expires(row.expiresAt)) return null;
  if (
    row.action === "review_price" &&
    exactKeys(row, [
      "action",
      "provider",
      "model",
      "priceVersion",
      "inputMicroUsdPerMillion",
      "cachedMicroUsdPerMillion",
      "outputMicroUsdPerMillion",
      "expiresAt",
      "sourceReference",
    ]) &&
    (row.provider === "openai" || row.provider === "google_gemini") &&
    officialPriceReviewSource(row.provider, row.sourceReference) &&
    typeof row.model === "string" &&
    MODEL.test(row.model) &&
    typeof row.priceVersion === "string" &&
    VERSION.test(row.priceVersion) &&
    integer(row.inputMicroUsdPerMillion, MAX) &&
    integer(row.cachedMicroUsdPerMillion, MAX) &&
    integer(row.outputMicroUsdPerMillion, MAX) &&
    BigInt(row.cachedMicroUsdPerMillion) <= BigInt(row.inputMicroUsdPerMillion) &&
    BigInt(row.inputMicroUsdPerMillion) + BigInt(row.outputMicroUsdPerMillion) > 0n
  ) {
    return row as NamedPriceReviewCommand;
  }
  if (
    row.action === "review_fx" &&
    exactKeys(row, ["action", "microEurPerMicroUsdNanos", "expiresAt", "sourceReference"]) &&
    officialPriceReviewSource("eur_usd", row.sourceReference) &&
    integer(row.microEurPerMicroUsdNanos, 10_000_000_000n) &&
    BigInt(row.microEurPerMicroUsdNanos) > 0n
  ) {
    return row as NamedPriceReviewCommand;
  }
  return null;
}

export class PostgresNamedPriceReviewStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async record(command: NamedPriceReviewCommand, identity: EditorIdentity): Promise<string> {
    if (
      !identity ||
      identity.role !== "admin" ||
      typeof identity.id !== "string" ||
      !UUID.test(identity.id) ||
      !Number.isSafeInteger(identity.authVersion) ||
      identity.authVersion < 0 ||
      identity.authVersion > 2147483647
    ) {
      throw new Error("Named price review unavailable");
    }
    const checked = parseNamedPriceReview(command);
    if (!checked) throw new Error("Named price review unavailable");
    try {
      const sql =
        checked.action === "review_price"
          ? "SELECT vns.admin_review_live_provider_price_as_editor(" +
            "$1::uuid,$2::integer,$3::text,$4::text,$5::text," +
            "$6::bigint,$7::bigint,$8::bigint,$9::timestamptz,$10::text)::text AS id"
          : "SELECT vns.admin_review_live_provider_fx_as_editor(" +
            "$1::uuid,$2::integer,$3::bigint,$4::timestamptz,$5::text)::text AS id";
      const args =
        checked.action === "review_price"
          ? [
              identity.id,
              identity.authVersion,
              checked.provider,
              checked.model,
              checked.priceVersion,
              checked.inputMicroUsdPerMillion,
              checked.cachedMicroUsdPerMillion,
              checked.outputMicroUsdPerMillion,
              checked.expiresAt,
              checked.sourceReference,
            ]
          : [
              identity.id,
              identity.authVersion,
              checked.microEurPerMicroUsdNanos,
              checked.expiresAt,
              checked.sourceReference,
            ];
      const result = await this.pool.query<{ id: string }>(sql, args);
      const id = result.rows[0]?.id;
      if (result.rows.length !== 1 || !id || !UUID.test(id)) {
        throw new Error("Invalid review receipt");
      }
      return id;
    } catch {
      throw new Error("Named price review unavailable");
    }
  }
}

/** Disabled by default. Only reviews price data; cannot activate any provider. */
export class NamedPriceFxReviewHttp {
  constructor(
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly auth: Pick<AdminAuth, "originAllowed">,
    private readonly store: Pick<PostgresNamedPriceReviewStore, "record">,
    private readonly limiter: { allow(): Promise<boolean> },
  ) {
    if (!limiter || typeof limiter.allow !== "function") {
      throw new Error("Named review admission unavailable");
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.url !== "/admin/ai-provider-pricing") return false;
    if (request.method !== "POST") {
      respond(response, 405, { error: "method_not_allowed" });
      return true;
    }
    let identity: EditorIdentity | null;
    try {
      identity = await this.editor.authenticatedAdminIdentity(request);
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
      return true;
    }
    if (!identity || identity.role !== "admin") {
      respond(response, 401, { error: "unauthorized" });
      return true;
    }
    if (!this.auth.originAllowed(request)) {
      respond(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      if ((await this.limiter.allow()) !== true) {
        respond(response, 429, { error: "too_many_requests" });
        return true;
      }
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
      return true;
    }
    const payload = parseNamedPriceReview(await readLimitedJson(request));
    if (!payload) {
      respond(response, 400, { error: "invalid_request" });
      return true;
    }
    try {
      const reviewId = await this.store.record(payload, identity);
      respond(response, 200, { reviewed: true, active: false, reviewId });
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
    }
    return true;
  }
}
