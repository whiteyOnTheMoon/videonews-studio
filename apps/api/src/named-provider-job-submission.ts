import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { sealProviderPrompt, type EncryptedProviderPrompt } from "@vns/shared";
import type { EditorAuth, EditorIdentity } from "./editor-auth.js";
import type { AdminAuth } from "./auth.js";
import { respond } from "./admin-provider-configuration.js";
import { withProviderPromptKey } from "./provider-master-key-file.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_KEY = /^[A-Za-z0-9_-]{24,80}$/;
const REQUEST = /^[A-Za-z0-9_-]{12,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LIMIT = 36000;

export type NamedProviderJobCommand = Readonly<{
  idempotencyKey: string;
  requestId: string;
  provider: "openai" | "google_gemini";
  model: string;
  priceSnapshotId: string;
  prompt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}>;

export function parseNamedProviderJob(input: unknown): NamedProviderJobCommand | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).length !== 8 ||
    !["idempotencyKey","requestId","provider","model","priceSnapshotId","prompt",
      "maxInputTokens","maxOutputTokens"].every((key) => Object.hasOwn(row, key)) ||
    typeof row.idempotencyKey !== "string" || !TOKEN_KEY.test(row.idempotencyKey) ||
    typeof row.requestId !== "string" || !REQUEST.test(row.requestId) ||
    (row.provider !== "openai" && row.provider !== "google_gemini") ||
    typeof row.model !== "string" || !MODEL.test(row.model) ||
    typeof row.priceSnapshotId !== "string" || !UUID.test(row.priceSnapshotId) ||
    typeof row.prompt !== "string" || !row.prompt.trim() ||
    Buffer.byteLength(row.prompt,"utf8") > 32768 ||
    !Number.isSafeInteger(row.maxInputTokens) ||
    (row.maxInputTokens as number) < 1 || (row.maxInputTokens as number) > 32768 ||
    !Number.isSafeInteger(row.maxOutputTokens) ||
    (row.maxOutputTokens as number) < 16 || (row.maxOutputTokens as number) > 4096 ||
    Buffer.byteLength(row.prompt,"utf8") > (row.maxInputTokens as number)
  ) return null;
  return row as NamedProviderJobCommand;
}

async function readJobBody(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers["content-encoding"] !== undefined
  ) return null;
  const declared = request.headers["content-length"];
  if (declared === undefined || Array.isArray(declared) ||
      !/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > LIMIT) return null;
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const part of request) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      length += bytes.length;
      if (length > LIMIT) return null;
      chunks.push(bytes);
    }
    if (length !== Number(declared)) return null;
    const raw = Buffer.concat(chunks);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    } finally {
      raw.fill(0);
    }
  } catch {
    return null;
  } finally {
    for (const part of chunks) part.fill(0);
  }
}

export class PostgresNamedProviderJobStore {
  constructor(private readonly db: Pick<Pool, "query">) {}

  async create(command: NamedProviderJobCommand, identity: EditorIdentity, key: Buffer): Promise<string> {
    const approved = parseNamedProviderJob(command);
    if (!approved || identity?.role !== "admin" ||
        typeof identity.id !== "string" || !UUID.test(identity.id) ||
        !Number.isSafeInteger(identity.authVersion) || identity.authVersion < 0 ||
        identity.authVersion > 2147483647) {
      throw new Error("Named provider job unavailable");
    }
    const sealed: EncryptedProviderPrompt = sealProviderPrompt(approved.prompt, key);
    try {
      const response = await this.db.query<{ id: string }>(
        "SELECT vns.admin_create_sealed_provider_job_as_editor(" +
          "$1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::text," +
          "$7::uuid,$8::text,$9::integer,$10::integer," +
          "$11::text,$12::text,$13::text)::text AS id",
        [identity.id, identity.authVersion, approved.idempotencyKey,
         approved.requestId, approved.provider, approved.model,
         approved.priceSnapshotId, sealed.sha256, approved.maxInputTokens,
         approved.maxOutputTokens, sealed.iv, sealed.tag, sealed.ciphertext],
      );
      const id = response.rows[0]?.id;
      if (response.rows.length !== 1 || typeof id !== "string" || !UUID.test(id)) {
        throw new Error("Invalid job receipt");
      }
      return id;
    } catch {
      throw new Error("Named provider job unavailable");
    }
  }
}

/**
 * Explicitly disabled unless composed by named provider runtime. This handler
 * creates a SQL pending intent only: it cannot enqueue or spend money.
 */
export class NamedProviderJobSubmissionHttp {
  constructor(
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly auth: Pick<AdminAuth, "originAllowed">,
    private readonly store: Pick<PostgresNamedProviderJobStore, "create">,
    private readonly limiter: { allow(): Promise<boolean> },
    private readonly withKey: typeof withProviderPromptKey = withProviderPromptKey,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.url !== "/admin/ai-provider-jobs") return false;
    if (request.method !== "POST") {
      respond(response, 405, { error: "method_not_allowed" });
      return true;
    }
    let identity: EditorIdentity | null;
    try {
      identity = await this.editor.authenticatedAdminIdentity(request);
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
      return true;
    }
    if (!identity || identity.role !== "admin") {
      respond(response, 401, { error: "unauthorized" });
      return true;
    }
    if (!this.auth.originAllowed(request)) {
      respond(response, 403, { error: "forbidden" });
      return true;
    }
    try {
      if ((await this.limiter.allow()) !== true) {
        respond(response, 429, { error: "too_many_requests" });
        return true;
      }
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
      return true;
    }
    const command = parseNamedProviderJob(await readJobBody(request));
    if (!command) {
      respond(response, 400, { error: "invalid_request" });
      return true;
    }
    try {
      const jobId = await this.withKey((key) => this.store.create(command, identity, key));
      respond(response, 202, { accepted: true, enqueued: false, active: false, jobId });
    } catch {
      respond(response, 503, { error: "temporarily_unavailable" });
    }
    return true;
  }
}
