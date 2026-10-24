import { adminJobsProxyConfig } from "../../../../../lib/admin-jobs-proxy";
import { submitAdminEvidenceReview, submitEditorEvidenceReview } from "../../../../../lib/admin-evidence-proxy";
import { editorProxyConfig } from "../../../../../lib/editor-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Named-editor mode never falls back to the shared admin session.
  if (process.env.VNS_WEB_EDITOR_AUTH_ENABLED === "true") {
    return submitEditorEvidenceReview(request, editorProxyConfig(process.env));
  }
  return submitAdminEvidenceReview(request, adminJobsProxyConfig(process.env));
}
