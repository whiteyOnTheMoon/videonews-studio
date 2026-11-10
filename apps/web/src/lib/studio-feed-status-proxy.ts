import { clientAdminCookie, isAdminAuthorized, type AdminProxyConfig } from "./admin-proxy";
import { clientEditorCookie, editorProfile, editorProxyConfig } from "./editor-proxy";
import { validStudioFeedStatus } from "./studio-feed-status";

const ID = /^vns-feed-tick-(0|[1-9][0-9]{0,13})$/;
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

export function studioFeedStatusProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_STUDIO_FEED_STATUS_ENABLED !== "true") return null;
  return editorProxyConfig(env);
}

/** GET uses read-only Redis credentials on API; no client-selected queue keys. */
export async function studioFeedStatusProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "GET") return reply(405, { error: "method_not_allowed" });
  const uri = new URL(request.url);
  const keys = [...uri.searchParams.keys()];
  const jobId = uri.searchParams.get("jobId");
  if (keys.length !== 1 || keys[0] !== "jobId" || !jobId || !ID.test(jobId)) {
    return reply(400, { error: "invalid_request" });
  }
  const admin = clientAdminCookie(request.headers.get("cookie"));
  const editor = clientEditorCookie(request.headers.get("cookie"));
  if (!admin || !editor) return reply(401, { error: "unauthorized" });
  if (!(await isAdminAuthorized(config, admin, fetcher))) {
    return reply(401, { error: "unauthorized" });
  }
  const profile = await editorProfile(request, config, fetcher);
  if (profile.status === 401) return reply(401, { error: "unauthorized" });
  if (profile.status !== 200) return reply(503, { error: "temporarily_unavailable" });
  const identity: unknown = await profile.json();
  if (
    !identity ||
    typeof identity !== "object" ||
    !("role" in identity) ||
    identity.role !== "admin"
  )
    return reply(403, { error: "forbidden" });
  try {
    const target = config.api + "/admin/studio-news-status?jobId=" + jobId;
    const upstream = await fetcher(target, {
      method: "GET",
      headers: { Cookie: admin + "; " + editor },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if ([400, 401, 403, 404, 405].includes(upstream.status)) {
      return reply(upstream.status, { error: "request_refused" });
    }
    if (upstream.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const raw = await upstream.text();
    if (raw.length > 1024) return reply(503, { error: "temporarily_unavailable" });
    const data: unknown = JSON.parse(raw);
    if (!validStudioFeedStatus(data, jobId)) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    return reply(200, data);
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
