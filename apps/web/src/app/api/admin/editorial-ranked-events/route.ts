import {
  dormantEditorialAdminProxy,
  editorialAdminProxyConfig,
} from "../../../../lib/admin-editorial-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Personally authenticated, read-only snapshots: never a publication gate. */
export async function GET(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(
    request,
    "ranked-events",
    editorialAdminProxyConfig(process.env),
  );
}
