import { privatePreviewProxy, privatePreviewProxyConfig } from "../../../../../lib/private-preview-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return privatePreviewProxy(request, "render", privatePreviewProxyConfig(process.env));
}
