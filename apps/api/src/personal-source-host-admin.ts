import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth, EditorIdentity } from "./editor-auth.js";
import { respond } from "./admin-provider-configuration.js";
import {
  applySourceAdminCommand,
  parseSourceAdminCommand,
  validateSourceSnapshot,
} from "./admin-source-registry.js";
import {
  parseHostApprovalCommand,
  validateHostApprovalSnapshot,
} from "./admin-source-host-approval.js";
import type {
  NamedEditorialPgSession,
  NamedEditorialSessionFactory,
} from "./personal-editorial-admin.js";

const SOURCE_PATH = "/admin/news-sources";
const HOST_PATH = "/admin/source-hosts";
const MAX_BODY_BYTES = 4096;
const MAX_WRITES_PER_MINUTE = 10;

function exactRevision(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function boundedJson(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers["content-encoding"] !== undefined
  )
    return null;
  const declared = request.headers["content-length"];
  if (
    Array.isArray(declared) ||
    (declared !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
  )
    return null;
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(buffer);
    }
    if (declared !== undefined && Number(declared) !== size) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return null;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/**
 * Strictly opt-in personal gateway; no shared source/host writer pool and no
 * asserted actor UUID in SQL. The physical PostgreSQL LOGIN is rechecked
 * against the cookie identity for each request before any governance query.
 *
 * Database revision/CAS and the 0061 default-off sole-owner policy remain
 * authoritative; the in-process write limit only provides defense in depth.
 */
export class DormantPersonalSourceHostAdmin {
  private readonly writes = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly origin: Pick<AdminAuth, "originAllowed">,
    private readonly sessions: NamedEditorialSessionFactory,
    private readonly sourceEnabled = false,
    private readonly hostEnabled = false,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!editor || !origin || !sessions || typeof sessions.open !== "function") {
      throw new Error("Personal source/host gateway dependencies unavailable");
    }
    if (hostEnabled && !sourceEnabled) {
      throw new Error("Host administration requires source administration");
    }
  }

  private allowWrite(actor: EditorIdentity): boolean {
    const now = this.clock().getTime();
    if (!Number.isFinite(now)) return false;
    // Bound memory independently of untrusted client IDs: authenticated actor
    // IDs only; active windows are short and the map is capped.
    for (const [key, value] of this.writes) {
      if (value.until <= now) this.writes.delete(key);
    }
    const current = this.writes.get(actor.id);
    if (current && current.count >= MAX_WRITES_PER_MINUTE) return false;
    if (!current && this.writes.size >= 100) return false;
    this.writes.set(actor.id, {
      count: (current?.count ?? 0) + 1,
      until: current?.until ?? now + 60000,
    });
    return true;
  }

  private async verifySession(session: NamedEditorialPgSession, actor: EditorIdentity) {
    const result = await session.query<{
      editor_id: string;
      auth_version: number;
      editor_role: string;
    }>("SELECT * FROM vns.named_current_editor()");
    return (
      result.rows.length === 1 &&
      result.rows[0]?.editor_id === actor.id &&
      result.rows[0]?.auth_version === actor.authVersion &&
      result.rows[0]?.editor_role === "admin"
    );
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = req.url;
    if (path !== SOURCE_PATH && path !== HOST_PATH) return false;

    if (
      (path === SOURCE_PATH && !this.sourceEnabled) ||
      (path === HOST_PATH && !this.hostEnabled)
    ) {
      respond(res, 404, { error: "not_found" });
      return true;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      respond(res, 405, { error: "method_not_allowed" });
      return true;
    }

    let actor: EditorIdentity | null;
    try {
      actor = await this.editor.authenticatedAdminIdentity(req);
    } catch {
      respond(res, 503, { error: "temporarily_unavailable" });
      return true;
    }
    if (!actor || actor.role !== "admin") {
      respond(res, 401, { error: "unauthorized" });
      return true;
    }
    if (req.method === "POST" && !this.origin.originAllowed(req)) {
      respond(res, 403, { error: "forbidden" });
      return true;
    }

    const command = req.method === "POST" ? await boundedJson(req) : undefined;
    const sourceCommand =
      path === SOURCE_PATH && req.method === "POST" ? parseSourceAdminCommand(command) : null;
    const hostCommand =
      path === HOST_PATH && req.method === "POST" ? parseHostApprovalCommand(command) : null;
    if (req.method === "POST" && !(sourceCommand || hostCommand)) {
      respond(res, 400, { error: "invalid_request" });
      return true;
    }
    if (req.method === "POST" && !this.allowWrite(actor)) {
      respond(res, 429, { error: "too_many_requests" });
      return true;
    }

    let session: NamedEditorialPgSession | undefined;
    try {
      session = await this.sessions.open(actor);
      if (!(await this.verifySession(session, actor))) {
        respond(res, 403, { error: "database_identity_mismatch" });
        return true;
      }

      if (path === SOURCE_PATH) {
        const result = await session.query<{
          revision: string | number;
          sources: unknown;
        }>("SELECT * FROM vns.named_source_read()");
        const current = result.rows[0];
        const revision = current && exactRevision(current.revision);
        if (result.rows.length !== 1 || !current || revision === null)
          throw new Error("Named source read unavailable");
        const snapshot = validateSourceSnapshot({
          revision,
          sources: current.sources,
        });
        if (req.method === "GET") {
          respond(res, 200, snapshot);
          return true;
        }

        const mutation = applySourceAdminCommand(
          snapshot,
          sourceCommand!,
          this.clock().toISOString().slice(0, 10),
        );
        if (!mutation) {
          respond(res, 409, { error: "source_conflict" });
          return true;
        }
        const saved = await session.query<{ saved: boolean }>(
          "SELECT vns.named_source_commit($1::bigint,$2::bigint,$3::jsonb,$4::text,$5::text) AS saved",
          [
            snapshot.revision,
            mutation.next.revision,
            JSON.stringify(mutation.next.sources),
            mutation.id,
            sourceCommand!.action,
          ],
        );
        if (saved.rows.length !== 1 || typeof saved.rows[0]?.saved !== "boolean")
          throw new Error("Named source commit unavailable");
        if (!saved.rows[0].saved) {
          respond(res, 409, { error: "revision_conflict" });
          return true;
        }
        respond(res, 200, {
          saved: true,
          revision: mutation.next.revision,
          sourceId: mutation.id,
          status: mutation.status,
          feedActive: false,
        });
        return true;
      }

      if (req.method === "GET") {
        const result = await session.query<{
          revision: string | number;
          approved_hosts: unknown;
        }>("SELECT * FROM vns.named_host_read()");
        const row = result.rows[0];
        const revision = row && exactRevision(row.revision);
        if (result.rows.length !== 1 || !row || revision === null)
          throw new Error("Named host read unavailable");
        const state = validateHostApprovalSnapshot({
          revision,
          approvedHosts: row.approved_hosts,
        });
        respond(res, 200, { ...state, feedActive: false });
        return true;
      }

      const saved = await session.query<{ saved: boolean }>(
        "SELECT vns.named_host_change($1::bigint,$2::bigint,$3::text,$4::text,$5::text) AS saved",
        [
          hostCommand!.expectedRevision,
          hostCommand!.expectedSourceRevision,
          hostCommand!.action,
          hostCommand!.host,
          hostCommand!.reason,
        ],
      );
      if (saved.rows.length !== 1 || typeof saved.rows[0]?.saved !== "boolean")
        throw new Error("Named host commit unavailable");
      if (!saved.rows[0].saved) {
        respond(res, 409, { error: "revision_conflict" });
        return true;
      }
      respond(res, 200, {
        saved: true,
        host: hostCommand!.host,
        action: hostCommand!.action,
        revision: hostCommand!.expectedRevision + 1,
        feedActive: false,
      });
      return true;
    } catch {
      respond(res, 503, { error: "temporarily_unavailable" });
      return true;
    } finally {
      await session?.close().catch(() => undefined);
    }
  }
}

export interface PersonalSourceHostGates {
  sourceEnabled: boolean;
  hostEnabled: boolean;
}

/** Default OFF; invalid or unacknowledged flags deny API startup. */
export function readPersonalSourceHostGates(
  env: NodeJS.ProcessEnv,
  hasPersonalSessions: boolean,
): PersonalSourceHostGates {
  const source = env.VNS_P2_SOURCE_ADMIN_ENABLED ?? "false";
  const host = env.VNS_P2_HOST_ADMIN_ENABLED ?? "false";
  const sourceAck = env.VNS_P2_SOURCE_ADMIN_OPERATOR_ACK ?? "false";
  const hostAck = env.VNS_P2_HOST_ADMIN_OPERATOR_ACK ?? "false";
  if (![source, host, sourceAck, hostAck].every((value) => ["true", "false"].includes(value))) {
    throw new Error("Personal source/host flags invalid");
  }
  const sourceEnabled = source === "true";
  const hostEnabled = host === "true";
  if (
    (sourceEnabled && (!hasPersonalSessions || sourceAck !== "true")) ||
    (hostEnabled && (!sourceEnabled || hostAck !== "true")) ||
    (!sourceEnabled && sourceAck !== "false") ||
    (!hostEnabled && hostAck !== "false")
  ) {
    throw new Error("Personal source/host admission denied");
  }
  return { sourceEnabled, hostEnabled };
}
