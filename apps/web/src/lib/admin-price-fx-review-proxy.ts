import { officialPriceReviewSource } from "@vns/shared";
import type { AdminProxyConfig } from "./admin-proxy";
import { clientEditorCookie, editorProfile, editorProxyConfig } from "./editor-proxy";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const VERSION = /^[A-Za-z0-9_-]{12,80}$/;
const UINT = /^(0|[1-9][0-9]{0,12})$/;
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function priceReviewProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_AI_PRICING_REVIEW_ENABLED !== "true") return null;
  return editorProxyConfig(env);
}
function reply(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
function keys(row: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(row).length === expected.length && expected.every((x) => Object.hasOwn(row, x))
  );
}
function integer(v: unknown, max: bigint): v is string {
  return typeof v === "string" && UINT.test(v) && BigInt(v) <= max;
}

function date(v: unknown): v is string {
  return (
    typeof v === "string" &&
    DATE.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().startsWith(v.slice(0, 19))
  );
}

export function parsePriceReviewBody(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  if (!date(row.expiresAt)) return null;
  if (
    row.action === "review_fx" &&
    keys(row, ["action", "microEurPerMicroUsdNanos", "expiresAt", "sourceReference"]) &&
    officialPriceReviewSource("eur_usd", row.sourceReference) &&
    integer(row.microEurPerMicroUsdNanos, 10_000_000_000n) &&
    BigInt(row.microEurPerMicroUsdNanos) > 0n
  )
    return row;
  if (
    row.action === "review_price" &&
    keys(row, [
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
    integer(row.inputMicroUsdPerMillion, 1_000_000_000_000n) &&
    integer(row.cachedMicroUsdPerMillion, 1_000_000_000_000n) &&
    integer(row.outputMicroUsdPerMillion, 1_000_000_000_000n) &&
    BigInt(row.cachedMicroUsdPerMillion) <= BigInt(row.inputMicroUsdPerMillion) &&
    BigInt(row.inputMicroUsdPerMillion) + BigInt(row.outputMicroUsdPerMillion) > 0n
  )
    return row;
  return null;
}
async function limitedBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    request.headers.has("content-encoding")
  )
    return null;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > 1024)) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024) return null;
      chunks.push(value);
    }
    if (declared !== null && length !== Number(declared)) return null;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } finally {
      bytes.fill(0);
    }
  } catch {
    return null;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => undefined);
  }
}

/** Explicitly opt-in BFF; never forwards an activation or API credential. */
export async function dormantPriceReviewProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (request.headers.get("origin") !== config.origin) {
    return reply(403, { error: "forbidden" });
  }
  const cookie = clientEditorCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  try {
    const profile = await editorProfile(request, config, fetcher);
    if (profile.status === 401) return reply(401, { error: "unauthorized" });
    if (profile.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const role: unknown = await profile.json();
    if (!role || typeof role !== "object" || !("role" in role) || role.role !== "admin") {
      return reply(403, { error: "forbidden" });
    }
    const payload = parsePriceReviewBody(await limitedBody(request));
    if (!payload) return reply(400, { error: "invalid_request" });
    const upstream = await fetcher(config.api + "/admin/ai-provider-pricing", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: config.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 401) return reply(401, { error: "unauthorized" });
    if (upstream.status === 403) return reply(403, { error: "forbidden" });
    if (upstream.status === 400) return reply(400, { error: "invalid_request" });
    if (upstream.status === 429) return reply(429, { error: "too_many_requests" });
    if (upstream.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const raw = await upstream.text();
    if (raw.length > 256) return reply(503, { error: "temporarily_unavailable" });
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    const result = data as Record<string, unknown>;
    if (
      Object.keys(result).length !== 3 ||
      result.reviewed !== true ||
      result.active !== false ||
      typeof result.reviewId !== "string" ||
      !UUID.test(result.reviewId)
    )
      return reply(503, { error: "temporarily_unavailable" });
    return reply(200, { reviewed: true, active: false, reviewId: result.reviewId });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
