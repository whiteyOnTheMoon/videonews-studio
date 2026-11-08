import {
  dormantEditorialAdminProxy,
  editorialAdminProxyConfig,
} from "../../../../lib/admin-editorial-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Personal Admin-only unranked metadata intake. */
export async function GET(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(request, "feed-inbox", editorialAdminProxyConfig(process.env));
}
