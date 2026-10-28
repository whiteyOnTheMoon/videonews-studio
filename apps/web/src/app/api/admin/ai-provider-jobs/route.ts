import {
  dormantProviderJobSubmissionProxy,
  providerJobSubmissionProxyConfig,
} from "../../../../lib/admin-provider-job-submission-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return dormantProviderJobSubmissionProxy(request, providerJobSubmissionProxyConfig(process.env));
}
