import {
  privatePreviewProxy,
  privatePreviewProxyConfig,
} from "../../../../../lib/private-preview-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await context.params;
  return privatePreviewProxy(request, "file", privatePreviewProxyConfig(process.env), file);
}
