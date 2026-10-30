import {
  dormantEditorialAdminProxy,
  editorialAdminProxyConfig,
} from "../../../../lib/admin-editorial-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Named review only, no source-rights or publication approval. */
export async function GET(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(
    request,
    "publisher-review",
    editorialAdminProxyConfig(process.env),
  );
}
export async function POST(request: Request): Promise<Response> {
  return dormantEditorialAdminProxy(
    request,
    "publisher-review",
    editorialAdminProxyConfig(process.env),
  );
}
