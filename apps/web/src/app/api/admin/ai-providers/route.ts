import {
  aiProviderReadOnlyProxyConfig,
  readOnlyAdminAiProvidersProxy,
} from "../../../../lib/admin-ai-providers-proxy";
import { dormantAdminAiProviderWriteProxy } from "../../../../lib/admin-ai-provider-write-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return readOnlyAdminAiProvidersProxy(request, aiProviderReadOnlyProxyConfig(process.env));
}

// Separate default-off gate: seeing provider metadata does not grant write access.
// Personal admin, origin, exact request framing and API re-auth are checked again
// by the bounded write proxy and the named SQL transaction.
export async function POST(request: Request): Promise<Response> {
  const config =
    process.env.VNS_WEB_AI_PROVIDER_WRITE_ENABLED === "true"
      ? aiProviderReadOnlyProxyConfig(process.env)
      : null;
  return dormantAdminAiProviderWriteProxy(request, config);
}
