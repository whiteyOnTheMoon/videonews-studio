import { adminJobsProxyConfig } from "../../../../../lib/admin-jobs-proxy";
import { submitAdminEvidenceReview } from "../../../../../lib/admin-evidence-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return submitAdminEvidenceReview(request, adminJobsProxyConfig(process.env));
}
