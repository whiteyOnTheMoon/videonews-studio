import { editorProfile, editorProxyConfig } from "../../../../lib/editor-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return editorProfile(request, editorProxyConfig(process.env));
}
