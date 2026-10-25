import {
  aiProviderReadOnlyProxyConfig,
  readOnlyAdminAiProvidersProxy,
} from "../../../../lib/admin-ai-providers-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return readOnlyAdminAiProvidersProxy(request, aiProviderReadOnlyProxyConfig(process.env));
}

// Deliberately no POST/PUT/PATCH/DELETE: keys cannot enter this BFF.
