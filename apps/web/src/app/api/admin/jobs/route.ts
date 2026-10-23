import { adminResearchJobProxy, adminJobsProxyConfig } from "../../../../lib/admin-jobs-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return adminResearchJobProxy(request, adminJobsProxyConfig(process.env));
}
