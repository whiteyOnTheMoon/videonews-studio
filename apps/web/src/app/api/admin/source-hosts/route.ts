import {
  dormantHostApprovalProxy,
  hostApprovalProxyConfig,
} from "../../../../lib/admin-source-hosts-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return dormantHostApprovalProxy(request, hostApprovalProxyConfig(process.env));
}
export async function POST(request: Request): Promise<Response> {
  return dormantHostApprovalProxy(request, hostApprovalProxyConfig(process.env));
}
