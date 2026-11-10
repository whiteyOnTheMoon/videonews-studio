import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { adminProxyConfig, isAdminAuthorized } from "../../lib/admin-proxy";
import { adminJobsProxyConfig } from "../../lib/admin-jobs-proxy";
import SignOut from "./sign-out";
import EditorLogin from "./editor-login";
import { editorProxyConfig } from "../../lib/editor-proxy";
import ResearchJobs from "./research-jobs";
import AiProviders from "./ai-providers";
import AiPriceFxReview from "./ai-price-fx-review";
import AiProviderJobs from "./ai-provider-jobs";
import { aiProviderReadOnlyProxyConfig } from "../../lib/admin-ai-providers-proxy";
import { priceReviewProxyConfig } from "../../lib/admin-price-fx-review-proxy";
import { sourceAdminProxyConfig } from "../../lib/admin-news-sources-proxy";
import NewsSources from "./news-sources";
import SourceHostApprovals from "./source-host-approvals";
import { hostApprovalProxyConfig } from "../../lib/admin-source-hosts-proxy";
import { editorialAdminProxyConfig } from "../../lib/admin-editorial-proxy";
import EditorialProfiles from "./editorial-profiles";
import EditorialAuditExport from "./editorial-audit-export";
import EditorialCheckpointEntry from "./editorial-checkpoint-entry";
import EditorialTimelineEntry from "./editorial-timeline-entry";
import EditorialRankedEvents from "./editorial-ranked-events";
import EditorialFeedInbox from "./editorial-feed-inbox";
import EditorialRankingPolicy from "./editorial-ranking-policy";
import EditorialMetadataReviews from "./editorial-metadata-reviews";
import StudioDashboard from "./studio-dashboard";

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
    <main className="shell studio-shell">
      <span className="eyebrow">VIDEO NEWS STUDIO</span>
      <h1>Dein Video-Studio</h1>
      <p>Aktuelle Earth-&-Climate-Themen auswählen, Videos erstellen und Vorschauen prüfen.</p>
      <StudioDashboard
        newsEnabled={editorialAdminProxyConfig(process.env) !== null}
        liveNewsEnabled={process.env.VNS_WEB_STUDIO_FEED_REFRESH_ENABLED === "true"}
        liveStatusEnabled={process.env.VNS_WEB_STUDIO_FEED_STATUS_ENABLED === "true"}
        previewEnabled={process.env.VNS_WEB_PRIVATE_PREVIEWS_ENABLED === "true"}
        renderEnabled={
          process.env.VNS_WEB_PRIVATE_PREVIEWS_ENABLED === "true" &&
          process.env.VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED === "true"
        }
        settings={
          <>
            <p>
              Erweiterte Werkzeuge, Anmeldungen, Quellenprüfungen und Anbieter-Konfiguration. Keine
              dieser Funktionen veröffentlicht Inhalte automatisch.
            </p>
            <EditorLogin enabled={editorProxyConfig(process.env) !== null} />
            <ResearchJobs enabled={adminJobsProxyConfig(process.env) !== null} />
            <AiProviders
              readOnlyEnabled={aiProviderReadOnlyProxyConfig(process.env) !== null}
              writeEnabled={process.env.VNS_WEB_AI_PROVIDER_WRITE_ENABLED === "true"}
            />
            <AiPriceFxReview enabled={priceReviewProxyConfig(process.env) !== null} />
            <AiProviderJobs enabled={process.env.VNS_WEB_AI_PROVIDER_JOBS_ENABLED === "true"} />
            <NewsSources enabled={sourceAdminProxyConfig(process.env) !== null} />
            <SourceHostApprovals enabled={hostApprovalProxyConfig(process.env) !== null} />
            <EditorialProfiles enabled={editorialAdminProxyConfig(process.env) !== null} />
            <EditorialFeedInbox enabled={editorialAdminProxyConfig(process.env) !== null} />
            <EditorialRankedEvents enabled={editorialAdminProxyConfig(process.env) !== null} />
            <EditorialRankingPolicy enabled={editorialAdminProxyConfig(process.env) !== null} />
            <EditorialMetadataReviews enabled={editorialAdminProxyConfig(process.env) !== null} />
            <EditorialAuditExport enabled={editorialAdminProxyConfig(process.env) !== null} />
            <EditorialCheckpointEntry enabled={editorialAdminProxyConfig(process.env) !== null} />
            <EditorialTimelineEntry enabled={editorialAdminProxyConfig(process.env) !== null} />
          </>
        }
      />
      <SignOut />
    </main>
  );
}
