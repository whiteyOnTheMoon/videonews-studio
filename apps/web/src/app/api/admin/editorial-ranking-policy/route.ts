import {
  dormantEditorialAdminProxy,
  editorialAdminProxyConfig,
} from "../../../../lib/admin-editorial-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Individually authenticated, revisioned metadata policy; no publishing. */
export async function GET(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(
    request,
    "ranking-policy",
    editorialAdminProxyConfig(process.env),
  );
}
export async function POST(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(
    request,
    "ranking-policy",
    editorialAdminProxyConfig(process.env),
  );
}
