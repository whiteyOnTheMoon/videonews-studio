import { adminJobsProxyConfig } from "./admin-jobs-proxy";
import type { AdminProxyConfig } from "./admin-proxy";

const COOKIE = "__Host-vns_editor";
const TOKEN = /^[0-9a-f]{64}$/;
const USERNAME = /^[a-z][a-z0-9_-]{2,31}$/;

export function editorProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_EDITOR_AUTH_ENABLED !== "true") return null;
  return adminJobsProxyConfig(env);
}

export function clientEditorCookie(raw: string | null): string | null {
  if (!raw) return null;
  const matches = raw
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(COOKIE + "="));
  if (matches.length !== 1) return null;
  const token = matches[0]?.slice(COOKIE.length + 1);
  return token && TOKEN.test(token) ? COOKIE + "=" + token : null;
}

function safeSetCookie(raw: string | null, action: "login" | "logout"): string | null {
  const match =
    /^__Host-vns_editor=([a-f0-9]{64}|); Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=(900|0)$/.exec(
      raw ?? "",
    );
  if (!match) return null;
  if (action === "login" && (!match[1] || match[2] !== "900")) return null;
  if (action === "logout" && (match[1] !== "" || match[2] !== "0")) return null;
  return raw;
}

function reply(status: number, body: object, cookie?: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return Response.json(body, { status, headers });
}

async function readCredentials(request: Request): Promise<string | null> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) return null;
      chunks.push(value);
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(buffer));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).length !== 2 ||
      typeof row.username !== "string" ||
      !USERNAME.test(row.username) ||
      typeof row.password !== "string" ||
      row.password.length < 12 ||
      row.password.length > 256
    )
      return null;
    return JSON.stringify({ username: row.username, password: row.password });
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function editorMutation(
  request: Request,
  action: "login" | "logout",
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (request.headers.get("origin") !== config.origin) return reply(403, { error: "forbidden" });
  const body = action === "login" ? await readCredentials(request) : null;
  const cookie = action === "logout" ? clientEditorCookie(request.headers.get("cookie")) : null;
  if (action === "login" && !body) return reply(400, { error: "invalid_request" });
  if (action === "logout" && !cookie) return reply(401, { error: "unauthorized" });
  try {
    const upstream = await fetcher(config.api + "/editor/auth/" + action, {
      method: "POST",
      headers: {
        Origin: config.origin,
        ...(action === "login"
          ? { "Content-Type": "application/json" }
          : { Cookie: cookie as string }),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 200) {
      const setCookie = safeSetCookie(upstream.headers.get("set-cookie"), action);
      if (!setCookie) return reply(503, { error: "temporarily_unavailable" });
      return reply(200, { authenticated: action === "login" }, setCookie);
    }
    if (upstream.status === 401 && action === "login") {
      return reply(401, { error: "invalid_credentials" });
    }
    if (upstream.status === 429) return reply(429, { error: "too_many_requests" });
    if (upstream.status === 403) return reply(403, { error: "forbidden" });
    return reply(503, { error: "temporarily_unavailable" });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}

export async function editorProfile(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  const cookie = clientEditorCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  try {
    const upstream = await fetcher(config.api + "/editor/me", {
      headers: { Cookie: cookie },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 401) return reply(401, { error: "unauthorized" });
    if (upstream.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const data: unknown = await upstream.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    const row = data as Record<string, unknown>;
    if (
      Object.keys(row).length !== 2 ||
      typeof row.username !== "string" ||
      !USERNAME.test(row.username) ||
      !["editor", "reviewer", "admin"].includes(row.role as string)
    ) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    return reply(200, { username: row.username, role: row.role });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
