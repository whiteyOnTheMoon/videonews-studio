import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth, EditorIdentity } from "./editor-auth.js";
import { respond } from "./admin-provider-configuration.js";

/**
 * Dormant P2-01 source administration. Every publisher and URL is supplied by
 * an editor; this module contains NO built-in feeds, API keys or approved hosts.
 * Real storage must enforce optimistic CAS and append an actor audit atomically.
 */
export interface SourceDraft {
  id: string;
  baseUrl: string;
  access: "rss" | "atom" | "official_api" | "html";
  intervalMinutes: number;
  termsUrl: string;
  usage: "metadata_only" | "reviewed_excerpt";
  licenseNotes: string;
}
export interface ManagedSource extends SourceDraft {
  status: "pending" | "approved" | "blocked";
  reviewedAt: string;
}
export interface SourceSnapshot {
  revision: number;
  sources: readonly ManagedSource[];
}
export type SourceAdminCommand =
  | { action: "create_pending" | "replace_pending"; expectedRevision: number; source: SourceDraft }
  | { action: "approve" | "block" | "reopen"; expectedRevision: number; sourceId: string };
export interface SourceAuditEvent {
  actorId: string;
  actorUsername: string;
  actorAuthVersion: number;
  sourceId: string;
  action: SourceAdminCommand["action"];
  revision: number;
  recordedAt: string;
}
export interface SourceAdminStore {
  read(): Promise<SourceSnapshot>;
  /**
   * Must lock and compare revision, replace snapshot, and append event in ONE
   * transaction. "conflict" is required on concurrent updates. No live store
   * or source scheduler is connected to this contract.
   */
  saveWithAudit(
    expectedRevision: number,
    next: SourceSnapshot,
    event: SourceAuditEvent,
  ): Promise<"saved" | "conflict">;
}

const SOURCE_ID = /^[a-z][a-z0-9_-]{2,40}$/;
const DRAFT_FIELDS = [
  "access", "baseUrl", "id", "intervalMinutes", "licenseNotes", "termsUrl", "usage",
];
const RECORD_FIELDS = [...DRAFT_FIELDS, "reviewedAt", "status"];
const MAX_BODY_BYTES = 4096;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}
function safeUrl(value: unknown, trailingSlash: boolean): value is string {
  if (typeof value !== "string" || value.length < 18 || value.length > 512) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return (
      url.protocol === "https:" &&
      url.toString() === value &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      !url.pathname.includes("%") &&
      (!trailingSlash || url.pathname.endsWith("/")) &&
      host.length <= 253 &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) &&
      host.split(".").every((label) => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-")) &&
      !/^(?:[0-9]+\.){3}[0-9]+$/.test(host) &&
      !host.endsWith(".local") &&
      !host.endsWith(".internal") &&
      !host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
function dateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validateSourceDraft(value: unknown): SourceDraft | null {
  if (!object(value) || !exact(value, DRAFT_FIELDS)) return null;
  if (
    typeof value.id !== "string" ||
    !SOURCE_ID.test(value.id) ||
    !safeUrl(value.baseUrl, true) ||
    !safeUrl(value.termsUrl, false) ||
    !["rss", "atom", "official_api", "html"].includes(value.access as string) ||
    !Number.isSafeInteger(value.intervalMinutes) ||
    (value.intervalMinutes as number) < 15 ||
    (value.intervalMinutes as number) > 10080 ||
    !["metadata_only", "reviewed_excerpt"].includes(value.usage as string) ||
    typeof value.licenseNotes !== "string" ||
    value.licenseNotes !== value.licenseNotes.trim() ||
    value.licenseNotes.length < 12 ||
    value.licenseNotes.length > 300 ||
    Array.from(value.licenseNotes).some((char) => char.charCodeAt(0) < 32)
  ) return null;
  return {
    id: value.id,
    baseUrl: value.baseUrl,
    access: value.access as SourceDraft["access"],
    intervalMinutes: value.intervalMinutes as number,
    termsUrl: value.termsUrl,
    usage: value.usage as SourceDraft["usage"],
    licenseNotes: value.licenseNotes,
  };
}
export function validateSourceSnapshot(value: unknown): SourceSnapshot {
  if (!object(value) || !exact(value, ["revision", "sources"]) ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !Array.isArray(value.sources) || value.sources.length > 20) {
    throw new Error("Source registry unavailable");
  }
  const ids = new Set<string>();
  const urls = new Set<string>();
  const sources: ManagedSource[] = [];
  for (const row of value.sources as unknown[]) {
    if (!object(row) || !exact(row, RECORD_FIELDS)) throw new Error("Source registry unavailable");
    const draft = validateSourceDraft(
      Object.fromEntries(DRAFT_FIELDS.map((field) => [field, row[field]])),
    );
    if (
      !draft ||
      !["pending", "approved", "blocked"].includes(row.status as string) ||
      !dateString(row.reviewedAt) ||
      ids.has(draft.id) ||
      urls.has(draft.baseUrl)
    ) throw new Error("Source registry unavailable");
    ids.add(draft.id);
    urls.add(draft.baseUrl);
    sources.push({
      ...draft,
      status: row.status as ManagedSource["status"],
      reviewedAt: row.reviewedAt,
    });
  }
  return { revision: value.revision as number, sources };
}
export function parseSourceAdminCommand(value: unknown): SourceAdminCommand | null {
  if (!object(value) || !Number.isSafeInteger(value.expectedRevision) ||
      (value.expectedRevision as number) < 0) return null;
  if (value.action === "create_pending" || value.action === "replace_pending") {
    if (!exact(value, ["action", "expectedRevision", "source"])) return null;
    const source = validateSourceDraft(value.source);
    return source
      ? { action: value.action, expectedRevision: value.expectedRevision as number, source }
      : null;
  }
  if (["approve", "block", "reopen"].includes(value.action as string) &&
      exact(value, ["action", "expectedRevision", "sourceId"]) &&
      typeof value.sourceId === "string" && SOURCE_ID.test(value.sourceId)) {
    return {
      action: value.action as "approve" | "block" | "reopen",
      expectedRevision: value.expectedRevision as number,
      sourceId: value.sourceId,
    };
  }
  return null;
}

export function applySourceAdminCommand(
  current: SourceSnapshot,
  command: SourceAdminCommand,
  reviewDate: string,
): { next: SourceSnapshot; id: string; status: ManagedSource["status"] } | null {
  if (!dateString(reviewDate) || current.revision !== command.expectedRevision ||
      current.revision >= Number.MAX_SAFE_INTEGER) return null;
  const sources = current.sources.map((source) => ({ ...source }));
  let id: string;
  let status: ManagedSource["status"];
  if (command.action === "create_pending") {
    id = command.source.id;
    if (sources.length >= 20 || sources.some((source) =>
      source.id === id || source.baseUrl === command.source.baseUrl)) return null;
    sources.push({ ...command.source, status: "pending", reviewedAt: reviewDate });
    status = "pending";
  } else if (command.action === "replace_pending") {
    id = command.source.id;
    const index = sources.findIndex((source) => source.id === id);
    if (index === -1 || sources.some((source) =>
      source.id !== id && source.baseUrl === command.source.baseUrl)) return null;
    sources[index] = { ...command.source, status: "pending", reviewedAt: reviewDate };
    status = "pending";
  } else {
    id = command.sourceId;
    const source = sources.find((source) => source.id === id);
    if (!source) return null;
    if (command.action === "approve") {
      if (source.status !== "pending") return null;
      status = "approved";
    } else if (command.action === "block") {
      if (source.status === "blocked") return null;
      status = "blocked";
    } else {
      if (source.status !== "blocked") return null;
      status = "pending";
    }
    source.status = status;
    source.reviewedAt = reviewDate;
  }
  return { next: { revision: current.revision + 1, sources }, id, status };
}

async function boundedJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
      request.headers["content-encoding"]) return null;
  const declared = request.headers["content-length"];
  if (Array.isArray(declared) || (declared !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES))) return null;
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const input of request) {
      const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
      size += bytes.byteLength;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(bytes);
    }
    if (declared !== undefined && Number(declared) !== size) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return null;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** Not mounted in server.ts or index.ts. No live source registration side effects. */
export class DormantNamedSourceAdmin {
  constructor(
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly origin: Pick<AdminAuth, "originAllowed">,
    private readonly store: SourceAdminStore,
    private readonly admission: { allow(): Promise<boolean> },
    private readonly enabled = false,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (enabled && (!admission || typeof admission.allow !== "function")) {
      throw new Error("Source registry admission required");
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.url !== "/admin/news-sources") return false;
    if (!this.enabled) {
      respond(res, 404, { error: "not_found" });
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
    if (req.method === "GET") {
      try {
        const snapshot = validateSourceSnapshot(await this.store.read());
        respond(res, 200, snapshot);
      } catch {
        respond(res, 503, { error: "temporarily_unavailable" });
      }
      return true;
    }
    if (req.method !== "POST") {
      respond(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!this.origin.originAllowed(req)) {
      respond(res, 403, { error: "forbidden" });
      return true;
    }
    try {
      if ((await this.admission.allow()) !== true) {
        respond(res, 429, { error: "too_many_requests" });
        return true;
      }
    } catch {
      respond(res, 503, { error: "temporarily_unavailable" });
      return true;
    }
    const command = parseSourceAdminCommand(await boundedJson(req));
    if (!command) {
      respond(res, 400, { error: "invalid_request" });
      return true;
    }
    try {
      const snapshot = validateSourceSnapshot(await this.store.read());
      if (snapshot.revision !== command.expectedRevision) {
        respond(res, 409, { error: "revision_conflict" });
        return true;
      }
      const now = this.clock();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error("Source clock unavailable");
      }
      const recordedAt = now.toISOString();
      const mutation = applySourceAdminCommand(snapshot, command, recordedAt.slice(0, 10));
      if (!mutation) {
        respond(res, 409, { error: "source_conflict" });
        return true;
      }
      const saved = await this.store.saveWithAudit(command.expectedRevision, mutation.next, {
        actorId: actor.id,
        actorUsername: actor.username,
        actorAuthVersion: actor.authVersion,
        sourceId: mutation.id,
        action: command.action,
        revision: mutation.next.revision,
        recordedAt,
      });
      if (saved !== "saved") {
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
    } catch {
      respond(res, 503, { error: "temporarily_unavailable" });
    }
    return true;
  }
}
