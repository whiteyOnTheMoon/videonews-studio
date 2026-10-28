import type { AdminProxyConfig } from "./admin-proxy";
import { clientEditorCookie, editorProfile, editorProxyConfig } from "./editor-proxy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_KEY = /^[A-Za-z0-9_-]{24,80}$/;
const REQUEST = /^[A-Za-z0-9_-]{12,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_BODY = 36000;

export function providerJobSubmissionProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_AI_PROVIDER_JOBS_ENABLED !== "true") return null;
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

function exact(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === 8 &&
    [
      "idempotencyKey",
      "requestId",
      "provider",
      "model",
      "priceSnapshotId",
      "prompt",
      "maxInputTokens",
      "maxOutputTokens",
    ].every((key) => Object.hasOwn(value, key))
  );
}

export function parseProviderJobSubmission(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !exact(row) ||
    typeof row.idempotencyKey !== "string" ||
    !TOKEN_KEY.test(row.idempotencyKey) ||
    typeof row.requestId !== "string" ||
    !REQUEST.test(row.requestId) ||
    (row.provider !== "openai" && row.provider !== "google_gemini") ||
    typeof row.model !== "string" ||
    !MODEL.test(row.model) ||
    typeof row.priceSnapshotId !== "string" ||
    !UUID.test(row.priceSnapshotId) ||
    typeof row.prompt !== "string" ||
    !row.prompt.trim() ||
    Buffer.byteLength(row.prompt, "utf8") > 32768 ||
    !Number.isSafeInteger(row.maxInputTokens) ||
    (row.maxInputTokens as number) < 1 ||
    (row.maxInputTokens as number) > 32768 ||
    !Number.isSafeInteger(row.maxOutputTokens) ||
    (row.maxOutputTokens as number) < 16 ||
    (row.maxOutputTokens as number) > 4096 ||
    Buffer.byteLength(row.prompt, "utf8") > (row.maxInputTokens as number)
  ) {
    return null;
  }
  return row;
}

async function boundedBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    request.headers.has("content-encoding")
  ) {
    return null;
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY)) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) return null;
      chunks.push(value);
    }
    if (declared !== null && Number(declared) !== size) return null;
    const buffer = new Uint8Array(size);
    let pos = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, pos);
      pos += chunk.length;
    }
    try {
      return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(buffer)) as unknown;
    } finally {
      buffer.fill(0);
    }
  } catch {
    return null;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => undefined);
  }
}

/** Admin BFF: creates pending SQL intent only; no Redis, provider or budgets. */
export async function dormantProviderJobSubmissionProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (request.headers.get("origin") !== config.origin) return reply(403, { error: "forbidden" });
  const cookie = clientEditorCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  try {
    const profile = await editorProfile(request, config, fetcher);
    if (profile.status === 401) return reply(401, { error: "unauthorized" });
    if (profile.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const identity: unknown = await profile.json();
    if (
      !identity ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      !("role" in identity) ||
      identity.role !== "admin"
    ) {
      return reply(403, { error: "forbidden" });
    }
    const input = parseProviderJobSubmission(await boundedBody(request));
    if (!input) return reply(400, { error: "invalid_request" });
    const upstream = await fetcher(config.api + "/admin/ai-provider-jobs", {
      method: "POST",
      headers: { Cookie: cookie, Origin: config.origin, "Content-Type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if ([400, 401, 403, 429].includes(upstream.status)) {
      return reply(upstream.status, {
        error: upstream.status === 400 ? "invalid_request" : "request_denied",
      });
    }
    if (upstream.status !== 202) return reply(503, { error: "temporarily_unavailable" });
    const raw = await upstream.text();
    if (raw.length > 256) return reply(503, { error: "temporarily_unavailable" });
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    const record = data as Record<string, unknown>;
    if (
      Object.keys(record).length !== 4 ||
      record.accepted !== true ||
      record.enqueued !== false ||
      record.active !== false ||
      typeof record.jobId !== "string" ||
      !UUID.test(record.jobId)
    ) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    return reply(202, { accepted: true, enqueued: false, active: false, jobId: record.jobId });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
