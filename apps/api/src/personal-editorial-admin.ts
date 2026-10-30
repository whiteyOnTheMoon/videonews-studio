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
/**
 * The worker scores a normalized whole-word/phrase match, not raw text.
 * Duplicate equivalent terms would otherwise inflate relevance scoring.
 */
function editorialTermKey(term: unknown): string | null {
  if (typeof term !== "string" || !/^[\p{L}\p{N} -]{2,50}$/u.test(term)) return null;
  const words = term
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]+/gu);
  return words?.length ? words.join(" ") : null;
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
    const uniqueTerms = new Set<string>();
    for (const term of terms) {
      const key = editorialTermKey(term);
      if (!key || uniqueTerms.has(key)) return null;
      uniqueTerms.add(key);
    }
    ids.add(raw.id);
    result.push(raw as unknown as EditorialProfileInput);
  }
  return result;
}

export interface NamedRankingPolicySettings {
  minimumPublisherGroups: number;
  relevanceWeight: number;
  freshnessWeight: number;
  qualityWeight: number;
  explanatoryWeight: number;
  visualizabilityWeight: number;
  riskWeight: number;
  maximumRisk: number;
}
const RANKING_SETTINGS_KEYS = [
  "minimumPublisherGroups",
  "relevanceWeight",
  "freshnessWeight",
  "qualityWeight",
  "explanatoryWeight",
  "visualizabilityWeight",
  "riskWeight",
  "maximumRisk",
] as const;
export function validateNamedRankingPolicySettings(
  raw: unknown,
): NamedRankingPolicySettings | null {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(",") !== [...RANKING_SETTINGS_KEYS].sort().join(",")
  )
    return null;
  for (const key of RANKING_SETTINGS_KEYS) {
    const n = raw[key];
    const low = key === "minimumPublisherGroups" ? 2 : 0;
    const high = key === "minimumPublisherGroups" || key === "maximumRisk" ? 5 : 100;
    if (!Number.isSafeInteger(n) || (n as number) < low || (n as number) > high) return null;
  }
  return raw as unknown as NamedRankingPolicySettings;
}

export interface NamedPublisherReviewWrite {
  sourceId: string;
  sourceRevision: number;
  publisherGroup: string;
  quality: number;
}
export interface NamedEventFactorReviewWrite {
  eventId: string;
  profileId: string;
  profileRevision: number;
  policyRevision: number;
  explanatoryValue: number;
  visualizability: number;
  risk: number;
}
/** Exact bounded review payloads. Browser cannot supply reviewer identity. */
export function validateNamedPublisherReviewWrite(raw: unknown): NamedPublisherReviewWrite | null {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(",") !== "publisherGroup,quality,sourceId,sourceRevision" ||
    typeof raw.sourceId !== "string" || !PROFILE_ID.test(raw.sourceId) ||
    typeof raw.publisherGroup !== "string" || !PROFILE_ID.test(raw.publisherGroup) ||
    revision(raw.sourceRevision) === null || (raw.sourceRevision as number) < 1 ||
    !Number.isSafeInteger(raw.quality) || (raw.quality as number) < 0 ||
    (raw.quality as number) > 5
  ) return null;
  return raw as unknown as NamedPublisherReviewWrite;
}
export function validateNamedEventFactorReviewWrite(raw: unknown): NamedEventFactorReviewWrite | null {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(",") !==
      "eventId,explanatoryValue,policyRevision,profileId,profileRevision,risk,visualizability" ||
    typeof raw.eventId !== "string" || !UUID.test(raw.eventId) ||
    typeof raw.profileId !== "string" || !PROFILE_ID.test(raw.profileId) ||
    revision(raw.profileRevision) === null ||
    revision(raw.policyRevision) === null || (raw.policyRevision as number) < 1 ||
    !["explanatoryValue", "visualizability", "risk"].every((key) =>
      Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0 && (raw[key] as number) <= 5
    )
  ) return null;
  return raw as unknown as NamedEventFactorReviewWrite;
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

const TIMELINE_KINDS = [
  "source",
  "claim",
  "claim_rejected",
  "review",
  "script_revision",
  "decision",
] as const;
const HTTPS_REFERENCE = /^https:\/\/[a-z0-9.-]+(?::443)?\/[a-zA-Z0-9/._~-]*$/;
export interface NamedTimelineWrite {
  storyId: string;
  eventKind: (typeof TIMELINE_KINDS)[number];
  referenceUri: string | null;
  documentSha256: string | null;
  details: { summary: string; reasonCodes: readonly string[] };
}
/** Restrict operator-authored timeline evidence to bounded, non-secret fields. */
export function validateNamedTimelineWrite(raw: unknown): NamedTimelineWrite | null {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(",") !== "details,documentSha256,eventKind,referenceUri,storyId" ||
    typeof raw.storyId !== "string" ||
    !UUID.test(raw.storyId) ||
    !TIMELINE_KINDS.includes(raw.eventKind as (typeof TIMELINE_KINDS)[number]) ||
    (raw.referenceUri !== null &&
      (typeof raw.referenceUri !== "string" ||
        raw.referenceUri.length > 2048 ||
        !HTTPS_REFERENCE.test(raw.referenceUri))) ||
    (raw.documentSha256 !== null &&
      (typeof raw.documentSha256 !== "string" || !SHA256.test(raw.documentSha256))) ||
    !object(raw.details) ||
    Object.keys(raw.details).sort().join(",") !== "reasonCodes,summary" ||
    typeof raw.details.summary !== "string" ||
    raw.details.summary.length < 8 ||
    raw.details.summary.length > 2000 ||
    [...raw.details.summary].some((char: string) => char.charCodeAt(0) < 32) ||
    !Array.isArray(raw.details.reasonCodes) ||
    raw.details.reasonCodes.length < 1 ||
    raw.details.reasonCodes.length > 20 ||
    raw.details.reasonCodes.some((x: unknown) => typeof x !== "string" || !REASON_CODE.test(x))
  )
    return null;
  return raw as unknown as NamedTimelineWrite;
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
        "/admin/editorial-ranked-events",
        "/admin/editorial-ranking-policy",
        "/admin/editorial-publisher-review",
        "/admin/editorial-event-factors",
      ].includes(path)
    )
      return false;
    if (!this.enabled) {
      respond(res, 404, { error: "not_found" });
      return true;
    }
    if (path === "/admin/editorial-ranked-events" && req.method !== "GET") {
      respond(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!["GET", "POST"].includes(req.method ?? "")) {
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
        : path === "/admin/editorial-ranking-policy"
          ? uri.search !== "" ||
            !object(command) ||
            Object.keys(command).sort().join(",") !== "expectedRevision,profileId,settings" ||
            typeof command.profileId !== "string" ||
            !PROFILE_ID.test(command.profileId) ||
            revision(command.expectedRevision) === null ||
            !validateNamedRankingPolicySettings(command.settings)
          : path === "/admin/editorial-publisher-review"
            ? uri.search !== "" || !validateNamedPublisherReviewWrite(command)
            : path === "/admin/editorial-event-factors"
              ? uri.search !== "" || !validateNamedEventFactorReviewWrite(command)
              : path === "/admin/editorial-checkpoints"
                ? uri.search !== "" || !validateNamedCheckpointWrite(command)
                : uri.search !== "" || !validateNamedTimelineWrite(command))
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
      } else if (path === "/admin/editorial-ranking-policy") {
        if (req.method === "GET") {
          if (
            [...uri.searchParams.keys()].length !== 1 ||
            !PROFILE_ID.test(uri.searchParams.get("profileId") ?? "")
          ) {
            respond(res, 400, { error: "invalid_request" });
            return true;
          }
          const rows = await session.query<{
            profile_revision: string | number;
            policy_revision: string | number;
            settings: unknown;
          }>("SELECT * FROM vns.named_ranking_policy_read($1::text)", [
            uri.searchParams.get("profileId"),
          ]);
          const item = rows.rows[0];
          if (
            rows.rows.length !== 1 ||
            !item ||
            revision(item.profile_revision) === null ||
            revision(item.policy_revision) === null ||
            (item.settings !== null && !validateNamedRankingPolicySettings(item.settings)) ||
            (revision(item.policy_revision) === 0) !== (item.settings === null)
          )
            throw new Error("Named ranking policy read invalid");
          respond(res, 200, {
            profileId: uri.searchParams.get("profileId"),
            profileRevision: revision(item.profile_revision),
            policyRevision: revision(item.policy_revision),
            settings: item.settings,
            productionActive: false,
          });
        } else {
          const input = command as Record<string, unknown>;
          const expected = revision(input.expectedRevision)!;
          const settings = validateNamedRankingPolicySettings(input.settings)!;
          const result = await session.query<{ saved: boolean }>(
            "SELECT vns.named_ranking_policy_commit($1::text,$2::bigint,$3::jsonb) AS saved",
            [input.profileId, expected, JSON.stringify(settings)],
          );
          if (result.rows.length !== 1 || typeof result.rows[0]?.saved !== "boolean")
            throw new Error("Named ranking policy commit invalid");
          if (!result.rows[0].saved) respond(res, 409, { error: "revision_conflict" });
          else
            respond(res, 200, {
              saved: true,
              policyRevision: expected + 1,
              productionActive: false,
            });
        }
      } else if (path === "/admin/editorial-publisher-review") {
        if (req.method === "GET") {
          const keys = [...uri.searchParams.keys()];
          const sourceId = uri.searchParams.get("sourceId");
          if (keys.length !== 1 || keys[0] !== "sourceId" ||
            !sourceId || !PROFILE_ID.test(sourceId)) {
            respond(res, 400, { error: "invalid_request" });
            return true;
          }
          const rows = await session.query<{
            source_revision: string | number;
            reviewed: boolean;
            publisher_group: string | null;
            quality: number | null;
          }>("SELECT * FROM vns.named_publisher_review_read($1::text)", [sourceId]);
          const item = rows.rows[0];
          if (rows.rows.length !== 1 || !item ||
            revision(item.source_revision) === null ||
            (revision(item.source_revision) as number) < 1 ||
            typeof item.reviewed !== "boolean" ||
            (item.reviewed
              ? typeof item.publisher_group !== "string" ||
                !PROFILE_ID.test(item.publisher_group) ||
                !Number.isSafeInteger(item.quality) ||
                (item.quality as number) < 0 || (item.quality as number) > 5
              : item.publisher_group !== null || item.quality !== null)
          ) throw new Error("Publisher review read invalid");
          respond(res, 200, {
            sourceId,
            sourceRevision: revision(item.source_revision),
            reviewed: item.reviewed,
            publisherGroup: item.publisher_group,
            quality: item.quality,
            approvedForPublication: false,
          });
        } else {
          const input = validateNamedPublisherReviewWrite(command)!;
          const rows = await session.query<{ saved: boolean }>(
            "SELECT vns.named_publisher_review_commit($1::text,$2::bigint,$3::text,$4::integer) AS saved",
            [input.sourceId,input.sourceRevision,input.publisherGroup,input.quality],
          );
          if (rows.rows.length !== 1 || typeof rows.rows[0]?.saved !== "boolean")
            throw new Error("Publisher review write invalid");
          if (!rows.rows[0].saved) respond(res, 409, { error: "revision_conflict" });
          else respond(res, 200, { saved: true, approvedForPublication: false });
        }
      } else if (path === "/admin/editorial-event-factors") {
        if (req.method === "GET") {
          const keys = [...uri.searchParams.keys()];
          const eventId = uri.searchParams.get("eventId");
          const profileId = uri.searchParams.get("profileId");
          if (keys.length !== 2 || !keys.includes("eventId") || !keys.includes("profileId") ||
            !eventId || !UUID.test(eventId) || !profileId || !PROFILE_ID.test(profileId)) {
            respond(res, 400, { error: "invalid_request" });
            return true;
          }
          const rows = await session.query<{
            profile_revision: string | number;
            policy_revision: string | number;
            reviewed: boolean;
            explanatory_value: number | null;
            visualizability: number | null;
            risk: number | null;
          }>("SELECT * FROM vns.named_event_factor_review_read($1::uuid,$2::text)",
             [eventId,profileId]);
          const item = rows.rows[0];
          if (rows.rows.length !== 1 || !item ||
            revision(item.profile_revision) === null ||
            revision(item.policy_revision) === null ||
            (revision(item.policy_revision) as number) < 1 ||
            typeof item.reviewed !== "boolean" ||
            (item.reviewed
              ? ![item.explanatory_value,item.visualizability,item.risk].every(
                (n) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 5)
              : item.explanatory_value !== null || item.visualizability !== null ||
                item.risk !== null)
          ) throw new Error("Event factor review read invalid");
          respond(res, 200, {
            eventId,
            profileId,
            profileRevision: revision(item.profile_revision),
            policyRevision: revision(item.policy_revision),
            reviewed: item.reviewed,
            explanatoryValue: item.explanatory_value,
            visualizability: item.visualizability,
            risk: item.risk,
            approvedForPublication: false,
          });
        } else {
          const input = validateNamedEventFactorReviewWrite(command)!;
          const rows = await session.query<{ saved: boolean }>(
            "SELECT vns.named_event_factor_review_commit($1::uuid,$2::text,$3::bigint,$4::bigint,$5::integer,$6::integer,$7::integer) AS saved",
            [input.eventId,input.profileId,input.profileRevision,input.policyRevision,
              input.explanatoryValue,input.visualizability,input.risk],
          );
          if (rows.rows.length !== 1 || typeof rows.rows[0]?.saved !== "boolean")
            throw new Error("Event factor write invalid");
          if (!rows.rows[0].saved) respond(res, 409, { error: "revision_conflict" });
          else respond(res, 200, { saved: true, approvedForPublication: false });
        }
      } else if (path === "/admin/editorial-ranked-events") {
        // Read-only SQL projection. The DB, not the API, chooses which
        // personally authenticated actor is permitted to read ranking.
        const keys = [...uri.searchParams.keys()];
        const limit = boundedInt(uri.searchParams.get("limit"), 1, 50);
        if (keys.length !== 1 || keys[0] !== "limit" || limit === null) {
          respond(res, 400, { error: "invalid_request" });
          return true;
        }
        const ranked = await session.query<{
          event_id: string;
          profile_id: string;
          profile_revision: string | number;
          headline: string;
          score: number;
          article_count: number;
          source_count: number;
          reasons: unknown;
          ranked_at: Date;
          approved_for_publication: boolean;
        }>("SELECT * FROM vns.named_ranked_feed_page($1::integer)", [limit]);
        if (
          ranked.rows.length > limit ||
          ranked.rows.some(
            (row) =>
              !UUID.test(row.event_id) ||
              !PROFILE_ID.test(row.profile_id) ||
              revision(row.profile_revision) === null ||
              typeof row.headline !== "string" ||
              row.headline.length < 8 ||
              row.headline.length > 200 ||
              !Number.isSafeInteger(row.score) ||
              row.score < 0 ||
              row.score > 1000 ||
              !Number.isSafeInteger(row.article_count) ||
              row.article_count < 1 ||
              row.article_count > 100 ||
              !Number.isSafeInteger(row.source_count) ||
              row.source_count < 1 ||
              row.source_count > row.article_count ||
              !Array.isArray(row.reasons) ||
              row.reasons.length < 2 ||
              row.reasons.length > 10 ||
              row.reasons.some((reason: unknown) => typeof reason !== "string") ||
              !row.reasons.includes("independent_verification_required") ||
              !(row.ranked_at instanceof Date) ||
              !Number.isFinite(row.ranked_at.getTime()) ||
              row.approved_for_publication !== false,
          )
        )
          throw new Error("Ranked feed page invalid");
        respond(res, 200, {
          candidates: ranked.rows.map((row) => ({
            eventId: row.event_id,
            profileId: row.profile_id,
            profileRevision: revision(row.profile_revision),
            headline: row.headline,
            score: row.score,
            articleCount: row.article_count,
            sourceCount: row.source_count,
            reasons: row.reasons,
            rankedAt: row.ranked_at.toISOString(),
            approvedForPublication: false,
          })),
          metadataOnly: true,
        });
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
        if (req.method === "POST") {
          const input = validateNamedTimelineWrite(command);
          if (!input) throw new Error("Timeline authorization missing");
          const rows = await session.query<{ event_id: string }>(
            "SELECT vns.named_timeline_append($1::uuid,$2::text,$3::text,$4::text,$5::jsonb) AS event_id",
            [
              input.storyId,
              input.eventKind,
              input.referenceUri,
              input.documentSha256,
              JSON.stringify(input.details),
            ],
          );
          const created = rows.rows[0]?.event_id;
          if (rows.rows.length !== 1 || typeof created !== "string" || !UUID.test(created)) {
            throw new Error("Timeline write result invalid");
          }
          respond(res, 200, { eventId: created, approvedForPublication: false });
          return true;
        }
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
