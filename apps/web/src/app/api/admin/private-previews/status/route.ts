import {
  privatePreviewProxy,
  privatePreviewProxyConfig,
} from "../../../../../lib/private-preview-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return privatePreviewProxy(request, "status", privatePreviewProxyConfig(process.env));
}
