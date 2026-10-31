import { createServer, type Server } from "node:http";
import { createHealth } from "@vns/shared";
import type { AdminAuth } from "./auth.js";
import type { AdminJobs } from "./admin-jobs.js";
import type { EditorAuth } from "./editor-auth.js";
import { NamedAdminProviderConfiguration } from "./named-admin-provider-configuration.js";
import { NamedProviderRequestRuntime } from "./named-provider-runtime.js";
import { DormantNamedSourceAdmin } from "./admin-source-registry.js";
import { DormantNamedHostApproval } from "./admin-source-host-approval.js";
import { DormantPersonalEditorialAdmin } from "./personal-editorial-admin.js";
import { DormantPersonalSourceHostAdmin } from "./personal-source-host-admin.js";

export function createApiServer(
  options: {
    auth?: AdminAuth;
    jobs?: AdminJobs;
    editor?: EditorAuth;
    providerConfig?: NamedAdminProviderConfiguration | NamedProviderRequestRuntime;
    sourceRegistry?: DormantNamedSourceAdmin;
    hostApprovals?: DormantNamedHostApproval;
    personalEditorial?: DormantPersonalEditorialAdmin;
    personalSourceHost?: DormantPersonalSourceHostAdmin;
  } = {},
): Server {
  if (options.jobs && !options.auth) throw new Error("Admin jobs require authentication");
  if (options.providerConfig && !options.auth)
    throw new Error("Provider configuration requires authentication");
  if (
    options.providerConfig &&
    !(options.providerConfig instanceof NamedAdminProviderConfiguration) &&
    !(options.providerConfig instanceof NamedProviderRequestRuntime)
  )
    throw new Error("Legacy provider configuration is forbidden");
  if (options.providerConfig && !options.editor)
    throw new Error("Named provider configuration requires personal editor authentication");
  if (options.sourceRegistry && !(options.sourceRegistry instanceof DormantNamedSourceAdmin))
    throw new Error("Source administration must use named-admin contract");
  if (options.sourceRegistry && (!options.auth || !options.editor))
    throw new Error("Source administration requires personal admin authentication");
  if (options.hostApprovals && !(options.hostApprovals instanceof DormantNamedHostApproval))
    throw new Error("Host approval requires named-admin contract");
  if (options.hostApprovals && (!options.auth || !options.editor))
    throw new Error("Host approval requires personal admin authentication");
  if (
    options.personalEditorial &&
    !(options.personalEditorial instanceof DormantPersonalEditorialAdmin)
  )
    throw new Error("Personal editorial handler contract required");
  if (options.personalEditorial && (!options.auth || !options.editor))
    throw new Error("Personal editorial handler requires named editor login");
  if (
    options.personalSourceHost &&
    !(options.personalSourceHost instanceof DormantPersonalSourceHostAdmin)
  )
    throw new Error("Personal source/host handler contract required");
  if (options.personalSourceHost && (!options.auth || !options.editor))
    throw new Error("Personal source/host requires named editor login");
  if (options.personalSourceHost && (options.sourceRegistry || options.hostApprovals))
    throw new Error("Conflicting legacy source/host handlers forbidden");
  if (options.editor && (!options.auth || !options.jobs))
    throw new Error("Editors require admin/data gates");
  return createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");

    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200);
      response.end(JSON.stringify(createHealth("api")));
      return;
    }

    // Default OFF: production index.ts never passes providerConfig.
    // Future opt-in must provide audited DB role, session, KEK and rate limiting.
    if (
      (request.url === "/admin/ai-provider-pricing" || request.url === "/admin/ai-provider-jobs") &&
      options.auth &&
      options.providerConfig instanceof NamedProviderRequestRuntime
    ) {
      void options.providerConfig.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        if (!response.writableEnded) {
          response.end(JSON.stringify({ error: "temporarily_unavailable" }));
        }
      });
      return;
    }

    if (request.url === "/admin/ai-providers" && options.auth && options.providerConfig) {
      void options.providerConfig.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        if (!response.writableEnded) {
          response.end(JSON.stringify({ error: "temporarily_unavailable" }));
        }
      });
      return;
    }

    // Explicitly personally bound SQL gateway, default OFF in index.ts.
    if (
      options.personalSourceHost &&
      (request.url === "/admin/news-sources" || request.url === "/admin/source-hosts")
    ) {
      void options.personalSourceHost.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        if (!response.writableEnded)
          response.end(JSON.stringify({ error: "temporarily_unavailable" }));
      });
      return;
    }

    // Legacy injected handlers remain dormant and are forbidden alongside the
    // new personally bound source/host handler.
    if (request.url === "/admin/news-sources" && options.sourceRegistry) {
      void options.sourceRegistry.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        if (!response.writableEnded) {
          response.end(JSON.stringify({ error: "temporarily_unavailable" }));
        }
      });
      return;
    }

    // Dormant by construction: index.ts never injects a host approval handler.
    if (request.url === "/admin/source-hosts" && options.hostApprovals) {
      void options.hostApprovals.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        if (!response.writableEnded) {
          response.end(JSON.stringify({ error: "temporarily_unavailable" }));
        }
      });
      return;
    }

    // Fully dormant unless an explicitly identity-bound personal PostgreSQL
    // connection factory is injected. index.ts never injects this handler.
    if (options.personalEditorial && request.url?.startsWith("/admin/editorial-")) {
      void options.personalEditorial
        .handle(request, response)
        .then((handled) => {
          if (!handled && !response.writableEnded) {
            response.writeHead(404);
            response.end(JSON.stringify({ error: "not_found" }));
          }
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(503);
          if (!response.writableEnded) {
            response.end(JSON.stringify({ error: "temporarily_unavailable" }));
          }
        });
      return;
    }

    if (request.url?.startsWith("/admin/evidence") && options.auth && options.jobs) {
      void options.jobs.handleEvidence(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        response.end(JSON.stringify({ error: "temporarily_unavailable" }));
      });
      return;
    }

    if (request.url === "/admin/jobs" && options.auth && options.jobs) {
      void options.jobs.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503);
        response.end(JSON.stringify({ error: "temporarily_unavailable" }));
      });
      return;
    }

    if (request.url?.startsWith("/editor/") && options.editor) {
      void options.editor
        .handle(request, response)
        .then((handled) => {
          if (!handled) {
            response.writeHead(404);
            response.end(JSON.stringify({ error: "not_found" }));
          }
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(503);
          response.end(JSON.stringify({ error: "temporarily_unavailable" }));
        });
      return;
    }

    if (options.auth) {
      void options.auth
        .handle(request, response)
        .then((handled) => {
          if (!handled) {
            response.writeHead(404);
            response.end(JSON.stringify({ error: "not_found" }));
          }
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end(JSON.stringify({ error: "internal_error" }));
        });
      return;
    }

    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  });
}
