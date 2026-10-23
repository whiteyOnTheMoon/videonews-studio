import { adminMutation, adminProxyConfig } from "../../../../lib/admin-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return adminMutation(request, "logout", adminProxyConfig(process.env));
}
