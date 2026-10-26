import {
  dormantSourceAdminProxy,
  sourceAdminProxyConfig,
} from "../../../../lib/admin-news-sources-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Explicitly opt-in only: missing flag returns 404; API runtime is independently unmounted.
export async function GET(request: Request): Promise<Response> {
  return dormantSourceAdminProxy(request, sourceAdminProxyConfig(process.env));
}
export async function POST(request: Request): Promise<Response> {
  return dormantSourceAdminProxy(request, sourceAdminProxyConfig(process.env));
}
