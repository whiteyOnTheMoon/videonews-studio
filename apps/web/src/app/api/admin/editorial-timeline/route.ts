import {
  dormantEditorialAdminProxy,
  editorialAdminProxyConfig,
} from "../../../../lib/admin-editorial-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(request, "timeline", editorialAdminProxyConfig(process.env));
}

export async function POST(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(request, "timeline", editorialAdminProxyConfig(process.env));
}
