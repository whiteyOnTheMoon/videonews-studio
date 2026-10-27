import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminProxyConfig, isAdminAuthorized } from "../../lib/admin-proxy";
import { adminJobsProxyConfig } from "../../lib/admin-jobs-proxy";
import SignOut from "./sign-out";
import EditorLogin from "./editor-login";
import { editorProxyConfig } from "../../lib/editor-proxy";
import ResearchJobs from "./research-jobs";
import AiProviders from "./ai-providers";
import { aiProviderReadOnlyProxyConfig } from "../../lib/admin-ai-providers-proxy";
import { sourceAdminProxyConfig } from "../../lib/admin-news-sources-proxy";
import NewsSources from "./news-sources";
import SourceHostApprovals from "./source-host-approvals";
import { hostApprovalProxyConfig } from "../../lib/admin-source-hosts-proxy";
import { editorialAdminProxyConfig } from "../../lib/admin-editorial-proxy";
import EditorialProfiles from "./editorial-profiles";
import EditorialAuditExport from "./editorial-audit-export";
import EditorialCheckpointEntry from "./editorial-checkpoint-entry";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const config = adminProxyConfig(process.env);
  if (!config) notFound();

  const cookieStore = await cookies();
  const raw = cookieStore.get("__Host-vns_session")?.value;
  const cookie = raw ? "__Host-vns_session=" + raw : null;
  if (!(await isAdminAuthorized(config, cookie))) {
    redirect("/admin/login");
  }

  return (
    <main className="shell">
      <span className="eyebrow">P1 · Internal admin preview</span>
      <h1>Admin-Bereich</h1>
      <p>
        Anmeldung bestätigt. Redaktionelle Prüf- und Konfigurationsfunktionen werden einzeln
        freigeschaltet und veröffentlichen keine Inhalte.
      </p>
      <div className="notice">Jede Anfrage wird serverseitig durch die Admin-API überprüft.</div>
      <EditorLogin enabled={editorProxyConfig(process.env) !== null} />
      <ResearchJobs enabled={adminJobsProxyConfig(process.env) !== null} />
      <AiProviders readOnlyEnabled={aiProviderReadOnlyProxyConfig(process.env) !== null} />
      <NewsSources enabled={sourceAdminProxyConfig(process.env) !== null} />
      <SourceHostApprovals enabled={hostApprovalProxyConfig(process.env) !== null} />
      <EditorialProfiles enabled={editorialAdminProxyConfig(process.env) !== null} />
      <EditorialAuditExport enabled={editorialAdminProxyConfig(process.env) !== null} />
      <EditorialCheckpointEntry enabled={editorialAdminProxyConfig(process.env) !== null} />
      <SignOut />
    </main>
  );
}
