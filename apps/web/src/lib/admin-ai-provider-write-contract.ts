import type { AdminProxyConfig } from "./admin-proxy";
import { clientEditorCookie, editorProfile } from "./editor-proxy";
import type { AdminAiProvider } from "./admin-ai-provider-view";

/**
 * Dormant named-admin key mutation contract: NOT imported by any Next.js route.
 * No real key entry or provider activation is permitted on the running system.
 * Personal editor-admin auth must be confirmed by the API before any forwarding.
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
  // Strict, byte-exact framing; compressed input is forbidden.
  if (request.headers.has("content-encoding")) return null;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > 1024)) {
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
      if (size > 1024) return null;
      chunks.push(value);
    }
    if (declared !== null && size !== Number(declared)) return null;
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
 * Future BFF command handler. The currently deployed route stays GET-only.
 * Offline tests inject configuration and a synthetic fetcher exclusively.
 *
 * Runtime activation requires the independently approved DB writer/KEK, personal
 * session propagation, rate admission and private network rollout.
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

  // Shared-admin cookies must NEVER authorize or be forwarded for key changes.
  const cookie = clientEditorCookie(request.headers.get("cookie"));
  if (!cookie) return safeReply(401, { error: "unauthorized" });

  // Verify the live personal editor session at the internal API, not a
  // browser-claimed role. The backend will independently recheck on POST.
  const profile = await editorProfile(request, config, fetcher);
  if (profile.status === 401) return safeReply(401, { error: "unauthorized" });
  if (profile.status !== 200) return safeReply(503, { error: "temporarily_unavailable" });
  const identity: unknown = await profile.json();
  if (
    !identity ||
    typeof identity !== "object" ||
    !("role" in identity) ||
    identity.role !== "admin"
  ) {
    return safeReply(403, { error: "forbidden" });
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
