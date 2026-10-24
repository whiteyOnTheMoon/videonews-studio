import { editorMutation, editorProxyConfig } from "../../../../lib/editor-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return editorMutation(request, "login", editorProxyConfig(process.env));
}
