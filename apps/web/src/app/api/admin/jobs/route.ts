import { adminResearchJobProxy, adminJobsProxyConfig } from "../../../../lib/admin-jobs-proxy";
import { adminResearchJobsList } from "../../../../lib/admin-jobs-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return adminResearchJobProxy(request, adminJobsProxyConfig(process.env));
}

export async function GET(request: Request): Promise<Response> {
  return adminResearchJobsList(request, adminJobsProxyConfig(process.env));
}
