import {
  dormantEditorialAdminProxy,
  editorialAdminProxyConfig,
} from "../../../../lib/admin-editorial-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(request, "checkpoints", editorialAdminProxyConfig(process.env));
}
