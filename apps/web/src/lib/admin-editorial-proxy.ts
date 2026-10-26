import type { AdminProxyConfig } from "./admin-proxy";
import { clientEditorCookie, editorProfile, editorProxyConfig } from "./editor-proxy";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
type EditorialEndpoint = "profiles" | "timeline" | "checkpoints";
const ENDPOINTS: Record<EditorialEndpoint, string> = {
  profiles: "/admin/editorial-profiles",
  timeline: "/admin/editorial-timeline",
  checkpoints: "/admin/editorial-checkpoints",
};

export function editorialAdminProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_EDITORIAL_ADMIN_ENABLED !== "true") return null;
  return editorProxyConfig(env);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reply(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
function numeric(value: string | null, minimum: number, maximum: number): boolean {
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum;
}
function validQuery(path: EditorialEndpoint, url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== new Set(keys).size) return false;
  if (path === "profiles") return keys.length === 0;
  if (path === "checkpoints") {
    const eventId = url.searchParams.get("eventId");
    return (
      keys.length === 3 &&
      keys.every((key) => ["eventId", "after", "limit"].includes(key)) &&
      !!eventId &&
      UUID.test(eventId) &&
      numeric(url.searchParams.get("after"), 0, 10000) &&
      numeric(url.searchParams.get("limit"), 1, 100)
    );
  }
  const storyId = url.searchParams.get("storyId");
  const afterTime = url.searchParams.get("afterTime");
  const afterId = url.searchParams.get("afterId");
  return (
    !!storyId &&
    UUID.test(storyId) &&
    numeric(url.searchParams.get("limit"), 1, 100) &&
    keys.every((key) => ["storyId", "limit", "afterTime", "afterId"].includes(key)) &&
    (afterTime === null) === (afterId === null) &&
    (afterId === null || UUID.test(afterId)) &&
    (afterTime === null ||
      (Number.isFinite(Date.parse(afterTime)) &&
        new Date(afterTime).toISOString() === afterTime))
  );
}
async function readBody(request: Request): Promise<string | null> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    request.headers.has("content-encoding")
  ) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) return null;
      chunks.push(value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(output);
    output.fill(0);
    const input: unknown = JSON.parse(raw);
    if (
      !object(input) || Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, "expectedRevision") ||
      !Object.hasOwn(input, "profiles") ||
      !Number.isSafeInteger(input.expectedRevision) ||
      (input.expectedRevision as number) < 0 ||
      !Array.isArray(input.profiles) || input.profiles.length > 20
    ) return null;
    return JSON.stringify(input);
  } catch {
    return null;
  } finally {
    chunks.forEach((part) => part.fill(0));
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Fixed-route, same-origin BFF; no browser-supplied backend URL or actor identity.
 * Both API auth and individual PostgreSQL session login are rechecked upstream.
 */
export async function dormantEditorialAdminProxy(
  request: Request,
  endpoint: EditorialEndpoint,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (!(endpoint in ENDPOINTS)) return reply(404, { error: "not_found" });
  if (request.method !== "GET" && !(endpoint === "profiles" && request.method === "POST")) {
    return reply(405, { error: "method_not_allowed" });
  }
  if (request.method === "POST" && request.headers.get("origin") !== config.origin) {
    return reply(403, { error: "forbidden" });
  }
  const url = new URL(request.url);
  if (!validQuery(endpoint, url)) return reply(400, { error: "invalid_request" });
  const cookie = clientEditorCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  const profile = await editorProfile(request, config, fetcher);
  if (profile.status === 401) return reply(401, { error: "unauthorized" });
  if (profile.status !== 200) return reply(503, { error: "temporarily_unavailable" });
  const actor: unknown = await profile.json();
  if (!object(actor) || actor.role !== "admin") return reply(403, { error: "forbidden" });
  const body = request.method === "POST" ? await readBody(request) : undefined;
  if (request.method === "POST" && !body) return reply(400, { error: "invalid_request" });
  try {
    const upstream = await fetcher(config.api + ENDPOINTS[endpoint] + url.search, {
      method: request.method,
      headers: {
        Cookie: cookie,
        ...(body ? { Origin: config.origin, "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if ([400, 401, 403, 409, 429].includes(upstream.status)) {
      return reply(upstream.status, { error: "request_refused" });
    }
    if (upstream.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const raw = await upstream.text();
    if (raw.length > 65536) return reply(503, { error: "temporarily_unavailable" });
    const value: unknown = JSON.parse(raw);
    if (!object(value)) return reply(503, { error: "temporarily_unavailable" });
    if (endpoint === "profiles" && request.method === "GET") {
      if (
        !Number.isSafeInteger(value.revision) || !Array.isArray(value.profiles) ||
        value.profiles.length > 20
      ) return reply(503, { error: "temporarily_unavailable" });
      return reply(200, { revision: value.revision, profiles: value.profiles });
    }
    if (endpoint === "profiles") {
      if (value.saved !== true || value.productionActive !== false ||
        !Number.isSafeInteger(value.revision)) {
        return reply(503, { error: "temporarily_unavailable" });
      }
      return reply(200, {
        saved: true,
        revision: value.revision,
        productionActive: false,
      });
    }
    if (!Array.isArray(value.events) || value.events.length > 100) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    if (endpoint === "timeline") return reply(200, { events: value.events, cursor: value.cursor });
    return reply(200, { events: value.events, nextRevision: value.nextRevision });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
