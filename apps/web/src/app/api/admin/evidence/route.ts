import { adminJobsProxyConfig } from "../../../../lib/admin-jobs-proxy";
import { listAdminEvidence } from "../../../../lib/admin-evidence-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return listAdminEvidence(request, adminJobsProxyConfig(process.env));
}
