import {
  adminProxyConfig,
  clientAdminCookie,
  isAdminAuthorized,
  type AdminProxyConfig,
} from "./admin-proxy";
import { parseAdminAiProviders } from "./admin-ai-provider-view";

// Backend endpoint and master key are dormant. This flag is deliberately
// unrelated to the active general admin account and defaults to false.
// Even with it enabled, the BFF remains GET-only and cannot accept secrets.
export function aiProviderReadOnlyProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_AI_PROVIDER_READONLY_ENABLED !== "true") return null;
  return adminProxyConfig(env);
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

export async function readOnlyAdminAiProvidersProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "GET") return reply(405, { error: "method_not_allowed" });
  const safeCookie = clientAdminCookie(request.headers.get("cookie"));
  if (!safeCookie) return reply(401, { error: "unauthorized" });

  // Explicitly verify the admin role with the live internal API. The
  // browser's raw cookie cannot grant access without server verification.
  if (!(await isAdminAuthorized(config, safeCookie, fetcher))) {
    return reply(401, { error: "unauthorized" });
  }

  try {
    const upstream = await fetcher(config.api + "/admin/ai-providers", {
      method: "GET",
      headers: { Cookie: safeCookie },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 401) return reply(401, { error: "unauthorized" });
    if (upstream.status === 403) return reply(403, { error: "forbidden" });
    if (upstream.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    // Reject oversized responses *before* parsing and never reflect unknown
    // provider fields, even if an upstream accidentally includes secrets.
    const raw = await upstream.text();
    if (raw.length > 2048) return reply(503, { error: "temporarily_unavailable" });
    const data: unknown = JSON.parse(raw);
    const providers = parseAdminAiProviders(data);
    if (!providers) return reply(503, { error: "temporarily_unavailable" });
    return reply(200, { providers });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
