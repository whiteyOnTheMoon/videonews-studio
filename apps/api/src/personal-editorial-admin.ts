import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminAuth } from "./auth.js";
import { respond } from "./admin-provider-configuration.js";
import type { EditorAuth, EditorIdentity } from "./editor-auth.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const PROFILE_ID = /^[a-z][a-z0-9_-]{2,40}$/;
const LOCALE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const BODY_LIMIT = 32768;
const PROFILE_KEYS = [
  "id",
  "language",
  "keywords",
  "blockedTerms",
  "minIndependentSources",
  "maximumArticleAgeHours",
  "format",
] as const;

export interface NamedEditorialPgSession {
  query<T>(sql: string, args?: readonly unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
export interface NamedEditorialSessionFactory {
  /** Must create a separate, personally authenticated PostgreSQL LOGIN connection. */
  open(identity: EditorIdentity): Promise<NamedEditorialPgSession>;
}
interface EditorialProfileInput {
  id: string;
  language: string;
  keywords: readonly string[];
  blockedTerms: readonly string[];
  minIndependentSources: number;
  maximumArticleAgeHours: number;
  format: "briefing" | "analysis" | "explainer";
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function revision(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
export function validateNamedEditorialProfiles(
  value: unknown,
): readonly EditorialProfileInput[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const ids = new Set<string>();
  const result: EditorialProfileInput[] = [];
  for (const raw of value) {
    if (
      !object(raw) ||
      Object.keys(raw).length !== PROFILE_KEYS.length ||
      !PROFILE_KEYS.every((key) => Object.hasOwn(raw, key)) ||
      typeof raw.id !== "string" ||
      !PROFILE_ID.test(raw.id) ||
      ids.has(raw.id) ||
      typeof raw.language !== "string" ||
      !LOCALE.test(raw.language) ||
      !Array.isArray(raw.keywords) ||
      !Array.isArray(raw.blockedTerms) ||
      raw.keywords.length > 30 ||
      raw.blockedTerms.length > 30 ||
      !Number.isSafeInteger(raw.minIndependentSources) ||
      (raw.minIndependentSources as number) < 1 ||
      (raw.minIndependentSources as number) > 5 ||
      !Number.isSafeInteger(raw.maximumArticleAgeHours) ||
      (raw.maximumArticleAgeHours as number) < 1 ||
      (raw.maximumArticleAgeHours as number) > 720 ||
      !["briefing", "analysis", "explainer"].includes(raw.format as string)
    ) {
      return null;
    }
    const terms = [...raw.keywords, ...raw.blockedTerms] as unknown[];
    if (
      terms.some(
        (term) =>
          typeof term !== "string" ||
          term.length < 2 ||
          term.length > 50 ||
          !/^[\p{L}\p{N} -]+$/u.test(term),
      )
    ) {
      return null;
    }
    ids.add(raw.id);
    result.push(raw as unknown as EditorialProfileInput);
  }
  return result;
}

const CHECKPOINT_STAGES = [
  "ranking",
  "claim_review",
  "freshness",
  "script_revision",
  "quality",
] as const;
const CHECKPOINT_OUTCOMES = ["candidate", "blocked", "needs_review"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{1,39}$/;
export interface NamedCheckpointWrite {
  eventId: string;
  expectedRevision: number;
  stage: (typeof CHECKPOINT_STAGES)[number];
  outcome: (typeof CHECKPOINT_OUTCOMES)[number];
  artifactSha256: string;
  reasonCodes: readonly string[];
  score: number | null;
}

/** Exactly the database contract. Never accept a browser-supplied actor. */
export function validateNamedCheckpointWrite(raw: unknown): NamedCheckpointWrite | null {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(",") !==
      "artifactSha256,eventId,expectedRevision,outcome,reasonCodes,score,stage" ||
    typeof raw.eventId !== "string" ||
    !UUID.test(raw.eventId) ||
    !Number.isSafeInteger(raw.expectedRevision) ||
    (raw.expectedRevision as number) < 0 ||
    (raw.expectedRevision as number) > 9999 ||
    !CHECKPOINT_STAGES.includes(raw.stage as (typeof CHECKPOINT_STAGES)[number]) ||
    !CHECKPOINT_OUTCOMES.includes(raw.outcome as (typeof CHECKPOINT_OUTCOMES)[number]) ||
    typeof raw.artifactSha256 !== "string" ||
    !SHA256.test(raw.artifactSha256) ||
    !Array.isArray(raw.reasonCodes) ||
    raw.reasonCodes.length < 1 ||
    raw.reasonCodes.length > 20 ||
    raw.reasonCodes.some((code: unknown) => typeof code !== "string" || !REASON_CODE.test(code)) ||
    (raw.score !== null &&
      (!Number.isSafeInteger(raw.score) ||
        (raw.score as number) < 0 ||
        (raw.score as number) > 1000))
  )
    return null;
  return raw as unknown as NamedCheckpointWrite;
}

async function boundedJson(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers["content-encoding"]
  ) {
    return null;
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.byteLength;
      if (bytes > BODY_LIMIT) return null;
      chunks.push(part);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    return null;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
function boundedInt(value: string | null, lower: number, upper: number): number | null {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= lower && n <= upper ? n : null;
}
function cursorTime(value: string | null): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}

/**
 * Explicitly injected Admin API only. It never opens or provisions database
 * connections, and it verifies that DB session_user maps to the same active
 * person as the rechecked authenticated editor cookie on every request.
 */
export class DormantPersonalEditorialAdmin {
  constructor(
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly origin: Pick<AdminAuth, "originAllowed">,
    private readonly sessions: NamedEditorialSessionFactory,
    private readonly enabled = false,
  ) {
    if (!editor || !origin || !sessions || typeof sessions.open !== "function") {
      throw new Error("Personal editorial gateway dependencies unavailable");
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const uri = new URL(req.url ?? "/", "http://internal.invalid");
    const path = uri.pathname;
    if (
      ![
        "/admin/editorial-profiles",
        "/admin/editorial-timeline",
        "/admin/editorial-checkpoints",
      ].includes(path)
    )
      return false;
    if (!this.enabled) {
      respond(res, 404, { error: "not_found" });
      return true;
    }
    if (
      !["GET", "POST"].includes(req.method ?? "") ||
      (req.method === "POST" && path === "/admin/editorial-timeline")
    ) {
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
    if (
      req.method === "POST" &&
      (path === "/admin/editorial-profiles"
        ? !object(command) ||
          Object.keys(command).length !== 2 ||
          !Object.hasOwn(command, "expectedRevision") ||
          !Object.hasOwn(command, "profiles") ||
          revision(command.expectedRevision) === null ||
          !validateNamedEditorialProfiles(command.profiles)
        : uri.search !== "" || !validateNamedCheckpointWrite(command))
    ) {
      respond(res, 400, { error: "invalid_request" });
      return true;
    }
    let session: NamedEditorialPgSession | undefined;
    try {
      session = await this.sessions.open(actor);
      const db = await session.query<{
        editor_id: string;
        auth_version: number;
        editor_role: string;
      }>("SELECT * FROM vns.named_current_editor()");
      if (
        db.rows.length !== 1 ||
        db.rows[0]?.editor_id !== actor.id ||
        db.rows[0]?.auth_version !== actor.authVersion ||
        db.rows[0]?.editor_role !== "admin"
      ) {
        respond(res, 403, { error: "database_identity_mismatch" });
        return true;
      }
      if (path === "/admin/editorial-profiles") {
        if (req.method === "GET") {
          const rows = await session.query<{ revision: number | string; profiles: unknown }>(
            "SELECT * FROM vns.named_profile_read()",
          );
          const current = rows.rows[0];
          const parsed = current && validateNamedEditorialProfiles(current.profiles);
          const currentRevision = current && revision(current.revision);
          if (rows.rows.length !== 1 || !parsed || currentRevision === null) {
            throw new Error("Personal profile read result invalid");
          }
          respond(res, 200, { revision: currentRevision, profiles: parsed });
        } else {
          const body = command as Record<string, unknown>;
          const expectedRevision = revision(body.expectedRevision)!;
          const profiles = validateNamedEditorialProfiles(body.profiles)!;
          const result = await session.query<{ saved: boolean }>(
            "SELECT vns.named_profile_commit($1::bigint,$2::jsonb) AS saved",
            [expectedRevision, JSON.stringify(profiles)],
          );
          if (result.rows.length !== 1 || typeof result.rows[0]?.saved !== "boolean") {
            throw new Error("Profile commit result invalid");
          }
          if (!result.rows[0].saved) respond(res, 409, { error: "revision_conflict" });
          else
            respond(res, 200, {
              saved: true,
              revision: expectedRevision + 1,
              productionActive: false,
            });
        }
      } else if (path === "/admin/editorial-checkpoints") {
        if (req.method === "POST") {
          const input = validateNamedCheckpointWrite(command);
          if (!input) throw new Error("Checkpoint authorization missing");
          const result = await session.query<{ saved: boolean }>(
            "SELECT vns.named_append_editorial_checkpoint($1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::jsonb,$7::integer) AS saved",
            [
              input.eventId,
              input.expectedRevision,
              input.stage,
              input.outcome,
              input.artifactSha256,
              JSON.stringify(input.reasonCodes),
              input.score,
            ],
          );
          if (result.rows.length !== 1 || typeof result.rows[0]?.saved !== "boolean") {
            throw new Error("Checkpoint write result invalid");
          }
          if (!result.rows[0].saved) respond(res, 409, { error: "revision_conflict" });
          else
            respond(res, 200, {
              saved: true,
              revision: input.expectedRevision + 1,
              approvedForPublication: false,
            });
          return true;
        }
        const eventId = uri.searchParams.get("eventId");
        const after = boundedInt(uri.searchParams.get("after"), 0, 10000);
        const limit = boundedInt(uri.searchParams.get("limit"), 1, 100);
        if (
          !eventId ||
          !UUID.test(eventId) ||
          after === null ||
          limit === null ||
          [...uri.searchParams.keys()].some((key) => !["eventId", "after", "limit"].includes(key))
        ) {
          respond(res, 400, { error: "invalid_request" });
          return true;
        }
        const rows = await session.query<Record<string, unknown>>(
          "SELECT * FROM vns.named_read_editorial_checkpoints($1::uuid,$2::integer,$3::integer)",
          [eventId, after, limit],
        );
        if (rows.rows.length > limit) throw new Error("Checkpoint page invalid");
        respond(res, 200, { events: rows.rows, nextRevision: rows.rows.at(-1)?.revision ?? after });
      } else {
        const storyId = uri.searchParams.get("storyId");
        const afterTimeInput = uri.searchParams.get("afterTime");
        const afterId = uri.searchParams.get("afterId");
        const limit = boundedInt(uri.searchParams.get("limit"), 1, 100);
        const afterTime = cursorTime(afterTimeInput);
        if (
          !storyId ||
          !UUID.test(storyId) ||
          limit === null ||
          (afterTimeInput !== null && afterTime === null) ||
          (afterId === null) !== (afterTimeInput === null) ||
          (afterId !== null && !UUID.test(afterId)) ||
          [...uri.searchParams.keys()].some(
            (key) => !["storyId", "afterTime", "afterId", "limit"].includes(key),
          )
        ) {
          respond(res, 400, { error: "invalid_request" });
          return true;
        }
        const rows = await session.query<{
          event_id: string;
          recorded_at: Date;
          [key: string]: unknown;
        }>("SELECT * FROM vns.named_timeline_page($1::uuid,$2::timestamptz,$3::uuid,$4::integer)", [
          storyId,
          afterTime,
          afterId,
          limit,
        ]);
        if (
          rows.rows.length > limit ||
          rows.rows.some(
            (row) =>
              !UUID.test(row.event_id) ||
              !(row.recorded_at instanceof Date) ||
              !Number.isFinite(row.recorded_at.getTime()),
          )
        ) {
          throw new Error("Timeline page invalid");
        }
        const last = rows.rows.at(-1);
        respond(res, 200, {
          events: rows.rows,
          cursor: last
            ? {
                afterTime: last.recorded_at.toISOString(),
                afterId: last.event_id,
              }
            : null,
        });
      }
    } catch {
      respond(res, 503, { error: "temporarily_unavailable" });
    } finally {
      await session?.close().catch(() => undefined);
    }
    return true;
  }
}
