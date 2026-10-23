// Server-side adapter only: no credentials, password hashes or API URLs go to the browser.
// Browser -> Next.js BFF -> internal API; public access requires separate HTTPS approval.
export interface AdminProxyConfig {
  origin: string;
  api: string;
}

const COOKIE_NAME = "__Host-vns_session";
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function adminProxyConfig(env: Record<string, string | undefined>): AdminProxyConfig | null {
  if (env.VNS_WEB_ADMIN_ENABLED !== "true") return null;
  const origin = env.VNS_ADMIN_ORIGIN;
  const internal = env.VNS_API_INTERNAL_URL;
  if (!origin || !internal) return null;
  try {
    const browser = new URL(origin);
    const api = new URL(internal);
    if (
      browser.protocol !== "https:" ||
      browser.origin !== origin ||
      browser.pathname !== "/" ||
      browser.search ||
      browser.hash ||
      browser.username ||
      browser.password ||
      api.protocol !== "http:" ||
      api.origin !== internal ||
      api.pathname !== "/" ||
      api.search ||
      api.hash ||
      api.username ||
      api.password ||
      !["api", "127.0.0.1", "localhost"].includes(api.hostname) ||
      api.port !== "4000"
    ) {
      return null;
    }
    return { origin, api: internal };
  } catch {
    return null;
  }
}

export function clientAdminCookie(raw: string | null): string | null {
  if (!raw) return null;
  const matches = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(COOKIE_NAME + "="));
  if (matches.length !== 1) return null;
  const token = matches[0]?.slice(COOKIE_NAME.length + 1);
  return token && TOKEN_PATTERN.test(token) ? COOKIE_NAME + "=" + token : null;
}

export function safeApiSetCookie(raw: string | null, action: "login" | "logout"): string | null {
  // Accept exactly the shape emitted by our API. No arbitrary upstream Set-Cookie passthrough.
  if (!raw) return null;
  const result =
    /^__Host-vns_session=([a-f0-9]{64}|); Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=(900|0)$/.exec(
      raw,
    );
  if (!result) return null;
  const token = result[1];
  const maxAge = result[2];
  if (action === "login" && (!token || maxAge !== "900")) return null;
  if (action === "logout" && (token !== "" || maxAge !== "0")) return null;
  return raw;
}

function reply(status: number, body: object, cookie?: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

async function limitedPassword(request: Request): Promise<string | null> {
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
      size += value.byteLength;
      if (size > 2048) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      payload !== null &&
      typeof payload === "object" &&
      "password" in payload &&
      typeof payload.password === "string" &&
      payload.password.length > 0 &&
      payload.password.length <= 1024
    ) {
      return payload.password;
    }
  } catch {
    // Neither request contents nor validation errors are logged.
  }
  return null;
}

type RequestAction = "login" | "logout";
type Fetcher = typeof fetch;

export async function adminMutation(
  request: Request,
  action: RequestAction,
  config: AdminProxyConfig | null,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (request.headers.get("origin") !== config.origin) return reply(403, { error: "forbidden" });

  let body: string | undefined;
  let cookie: string | null = null;
  if (action === "login") {
    const password = await limitedPassword(request);
    if (password === null) return reply(400, { error: "invalid_request" });
    body = JSON.stringify({ password });
  } else {
    cookie = clientAdminCookie(request.headers.get("cookie"));
    if (!cookie) return reply(401, { error: "unauthorized" });
  }

  try {
    const upstream = await fetcher(
      config.api + (action === "login" ? "/auth/login" : "/auth/logout"),
      {
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
      },
    );

    if (upstream.status === 200) {
      const setCookie = safeApiSetCookie(upstream.headers.get("set-cookie"), action);
      if (!setCookie) return reply(503, { error: "temporarily_unavailable" });
      return reply(
        200,
        action === "login" ? { authenticated: true } : { authenticated: false },
        setCookie,
      );
    }
    if (action === "login" && upstream.status === 401) {
      return reply(401, { error: "invalid_credentials" });
    }
    if (upstream.status === 429) return reply(429, { error: "too_many_requests" });
    if (upstream.status === 403) return reply(403, { error: "forbidden" });
    return reply(503, { error: "temporarily_unavailable" });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}

export async function isAdminAuthorized(
  config: AdminProxyConfig | null,
  cookie: string | null,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  if (!config || !cookie) return false;
  const safeCookie = clientAdminCookie(cookie);
  if (!safeCookie) return false;
  try {
    const upstream = await fetcher(config.api + "/admin/me", {
      headers: { Cookie: safeCookie },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status !== 200) return false;
    const data: unknown = await upstream.json();
    return typeof data === "object" && data !== null && "role" in data && data.role === "admin";
  } catch {
    return false;
  }
}
