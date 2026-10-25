import { clientAdminCookie, isAdminAuthorized, type AdminProxyConfig } from "./admin-proxy";
import type { AdminAiProvider } from "./admin-ai-provider-view";

/**
 * Dormant server-side key mutation contract: NOT imported by any Next.js route.
 * No real key entry or provider activation is permitted on the running system.
 * Provider keys may only transit to a separately enabled INTERNAL API someday.
 */
export type AdminAiProviderMutation =
  | { action: "set_key"; provider: AdminAiProvider; apiKey: string }
  | { action: "remove_key"; provider: AdminAiProvider }
  | { action: "set_model"; provider: AdminAiProvider; model: string };

const models: Record<AdminAiProvider, readonly string[]> = {
  openai: ["gpt-6-luna", "gpt-6.1-sol"],
  google_gemini: ["gemini-3.8-flash-tts"],
};

function providerName(value: unknown): value is AdminAiProvider {
  return value === "openai" || value === "google_gemini";
}

function exactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(input).length === expected.length &&
    expected.every((name) => Object.hasOwn(input, name))
  );
}

function printableKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 12 &&
    value.length <= 512 &&
    [...value].every((character) => {
      const point = character.charCodeAt(0);
      return point >= 33 && point <= 126;
    })
  );
}

/** Returns canonical, allowlisted commands only; reject extras and activation. */
export function parseAdminAiProviderMutation(payload: unknown): AdminAiProviderMutation | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const input = payload as Record<string, unknown>;
  if (!providerName(input.provider)) return null;

  if (
    input.action === "set_key" &&
    exactKeys(input, ["action", "provider", "apiKey"]) &&
    printableKey(input.apiKey)
  ) {
    return {
      action: "set_key",
      provider: input.provider,
      apiKey: input.apiKey,
    };
  }
  if (input.action === "remove_key" && exactKeys(input, ["action", "provider"])) {
    return { action: "remove_key", provider: input.provider };
  }
  if (
    input.action === "set_model" &&
    exactKeys(input, ["action", "provider", "model"]) &&
    typeof input.model === "string" &&
    models[input.provider].includes(input.model)
  ) {
    return {
      action: "set_model",
      provider: input.provider,
      model: input.model,
    };
  }
  return null;
}

function safeReply(status: number, body: object): Response {
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

async function limitedJsonBody(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return null;
  }
  if (request.headers.has("content-length")) {
    const declared = request.headers.get("content-length");
    if (!declared || !/^\d+$/.test(declared) || Number(declared) > 1024) return null;
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
      if (size > 1024) return null;
      chunks.push(value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as unknown;
    } finally {
      buffer.fill(0);
      chunks.forEach((chunk) => chunk.fill(0));
    }
  } catch {
    return null;
  } finally {
    // Best-effort clear even on oversize, invalid UTF-8 or stream failure.
    chunks.forEach((chunk) => chunk.fill(0));
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Future BFF command handler; can be tested ONLY with explicit injected config
 * and synthetic fetcher. No production route calls it.
 *
 * Future activation needs server-side rate limits, approved role/DB/KEK custody,
 * HTTPS + CSRF controls and redacted request logging.
 */
export async function dormantAdminAiProviderWriteProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return safeReply(404, { error: "not_found" });
  if (request.method !== "POST") return safeReply(405, { error: "method_not_allowed" });
  if (request.headers.get("origin") !== config.origin) {
    return safeReply(403, { error: "forbidden" });
  }

  const cookie = clientAdminCookie(request.headers.get("cookie"));
  if (!cookie) return safeReply(401, { error: "unauthorized" });

  // Check actual backend admin session, not a browser-claimed role.
  if (!(await isAdminAuthorized(config, cookie, fetcher))) {
    return safeReply(401, { error: "unauthorized" });
  }

  const payload = parseAdminAiProviderMutation(await limitedJsonBody(request));
  if (!payload) return safeReply(400, { error: "invalid_request" });

  try {
    const upstream = await fetcher(config.api + "/admin/ai-providers", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: config.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });

    if (upstream.status === 401) return safeReply(401, { error: "unauthorized" });
    if (upstream.status === 403) return safeReply(403, { error: "forbidden" });
    if (upstream.status === 400) return safeReply(400, { error: "invalid_request" });
    if (upstream.status === 429) return safeReply(429, { error: "too_many_requests" });
    if (upstream.status !== 200) {
      return safeReply(503, { error: "temporarily_unavailable" });
    }
    const raw = await upstream.text();
    if (raw.length > 128) return safeReply(503, { error: "temporarily_unavailable" });
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return safeReply(503, { error: "temporarily_unavailable" });
    }
    const result = data as Record<string, unknown>;
    if (Object.keys(result).length !== 2 || result.saved !== true || result.active !== false) {
      return safeReply(503, { error: "temporarily_unavailable" });
    }
    return safeReply(200, { saved: true, active: false });
  } catch {
    return safeReply(503, { error: "temporarily_unavailable" });
  }
}
