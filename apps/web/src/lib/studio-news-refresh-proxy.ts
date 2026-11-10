import {
  clientAdminCookie,
  isAdminAuthorized,
  type AdminProxyConfig,
} from "./admin-proxy";
import { clientEditorCookie, editorProfile, editorProxyConfig } from "./editor-proxy";

function reply(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function studioNewsRefreshProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_STUDIO_FEED_REFRESH_ENABLED !== "true") return null;
  return editorProxyConfig(env);
}

/** Browser never provides an article URL, source ID, queue job or request body. */
export async function studioNewsRefreshProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (new URL(request.url).search !== "") return reply(400, { error: "invalid_request" });
  if (request.headers.get("origin") !== config.origin) {
    return reply(403, { error: "forbidden" });
  }
  if (request.body !== null) return reply(400, { error: "invalid_request" });

  const adminCookie = clientAdminCookie(request.headers.get("cookie"));
  const editorCookie = clientEditorCookie(request.headers.get("cookie"));
  if (!adminCookie || !editorCookie) return reply(401, { error: "unauthorized" });
  if (!(await isAdminAuthorized(config, adminCookie, fetcher))) {
    return reply(401, { error: "unauthorized" });
  }
  const profile = await editorProfile(request, config, fetcher);
  if (profile.status === 401) return reply(401, { error: "unauthorized" });
  if (profile.status !== 200) return reply(503, { error: "temporarily_unavailable" });
  const actor: unknown = await profile.json();
  if (!actor || typeof actor !== "object" || !("role" in actor) || actor.role !== "admin") {
    return reply(403, { error: "forbidden" });
  }

  try {
    const upstream = await fetcher(config.api + "/admin/studio-news-refresh", {
      method: "POST",
      headers: {
        Origin: config.origin,
        Cookie: adminCookie + "; " + editorCookie,
      },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if ([401, 403, 404, 405].includes(upstream.status)) {
      return reply(upstream.status, { error: "request_refused" });
    }
    if (upstream.status !== 202) return reply(503, { error: "temporarily_unavailable" });
    const raw = await upstream.text();
    if (raw.length > 512) return reply(503, { error: "temporarily_unavailable" });
    const data: unknown = JSON.parse(raw);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "accepted,completed,publishingAllowed,queueJobId" ||
      !("accepted" in data) ||
      data.accepted !== true ||
      !("completed" in data) ||
      data.completed !== false ||
      !("publishingAllowed" in data) ||
      data.publishingAllowed !== false ||
      !("queueJobId" in data) ||
      typeof data.queueJobId !== "string" ||
      !/^vns-feed-tick-[0-9]{1,14}$/.test(data.queueJobId)
    ) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    return reply(202, data as object);
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
