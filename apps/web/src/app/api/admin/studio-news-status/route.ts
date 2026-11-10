import {
  studioFeedStatusProxy,
  studioFeedStatusProxyConfig,
} from "../../../../lib/studio-feed-status-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return studioFeedStatusProxy(request, studioFeedStatusProxyConfig(process.env));
}
