import {
  studioNewsRefreshProxy,
  studioNewsRefreshProxyConfig,
} from "../../../../lib/studio-news-refresh-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return studioNewsRefreshProxy(request, studioNewsRefreshProxyConfig(process.env));
}
