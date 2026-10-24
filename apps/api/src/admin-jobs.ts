import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import type { Pool } from "pg";
import type { AdminAuth } from "./auth.js";
import { AdminEvidence, PostgresEvidenceReviewStore } from "./admin-evidence.js";

const KEY_PATTERN = /^[a-zA-Z0-9_-]{24,80}$/;
export function validResearchTopic(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.split("").some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return false;
  const length = Array.from(value).length;
  return length >= 12 && length <= 160;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ResearchJobSummary {
  id: string;
  kind: "research";
  topic: string | null;
  status: "pending" | "running" | "retry" | "done" | "failed" | "cancelled";
  deliveryState: "pending" | "enqueued";
  createdAt: string;
}

export interface ResearchJobStore {
  createResearchJob(key: string, topic: string): Promise<string>;
  listRecentResearchJobs(): Promise<ResearchJobSummary[]>;
  close?(): Promise<void>;
}

export function parseResearchJobRequest(
  value: unknown,
): { idempotencyKey: string; topic: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 3 ||
    body.kind !== "research" ||
    typeof body.idempotencyKey !== "string" ||
    !KEY_PATTERN.test(body.idempotencyKey) ||
    !validResearchTopic(body.topic)
  ) {
    return null;
  }
  return { idempotencyKey: body.idempotencyKey, topic: body.topic };
}

export function validJobSummary(value: unknown): value is ResearchJobSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 6 &&
    typeof row.id === "string" &&
    UUID_PATTERN.test(row.id) &&
    row.kind === "research" &&
    (row.topic === null || validResearchTopic(row.topic)) &&
    typeof row.status === "string" &&
    ["pending", "running", "retry", "done", "failed", "cancelled"].includes(row.status) &&
    (row.deliveryState === "pending" || row.deliveryState === "enqueued") &&
    typeof row.createdAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.createdAt) &&
    !Number.isNaN(Date.parse(row.createdAt))
  );
}

async function limitedJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 1024) return null;
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function respond(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

export class AdminJobs {
  constructor(
    private readonly auth: AdminAuth,
    private readonly store: ResearchJobStore,
    private readonly evidence?: AdminEvidence,
  ) {}

  async handleEvidence(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.evidence) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    await this.evidence.handle(request, response);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.auth.hasAdminSession(request)) {
      respond(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET") {
      try {
        const jobs = await this.store.listRecentResearchJobs();
        if (jobs.length > 20 || !jobs.every(validJobSummary)) {
          throw new Error("Invalid research job list");
        }
        respond(response, 200, { jobs });
      } catch {
        respond(response, 503, { error: "temporarily_unavailable" });
      }
      return;
    }
    if (request.method !== "POST") {
      respond(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (!this.auth.originAllowed(request)) {
      respond(response, 403, { error: "forbidden" });
      return;
    }
    const submission = parseResearchJobRequest(await limitedJson(request));
    if (!submission) {
      respond(response, 400, { error: "invalid_request" });
      return;
    }
    try {
      const jobId = await this.store.createResearchJob(submission.idempotencyKey, submission.topic);
      if (!UUID_PATTERN.test(jobId)) throw new Error("Invalid database job identifier");
      // Accepted into PostgreSQL only; no claim of Redis enqueue/completion.
      respond(response, 202, { accepted: true, jobId });
    } catch (error) {
      // SQLSTATE 22023 represents incompatible reuse of an idempotency key.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "22023"
      ) {
        respond(response, 409, { error: "idempotency_conflict" });
        return;
      }
      // Never expose DB credentials, SQL, internal hostnames or raw errors.
      respond(response, 503, { error: "temporarily_unavailable" });
    }
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}

class PostgresResearchJobStore implements ResearchJobStore {
  constructor(private readonly pool: Pool) {}

  async createResearchJob(key: string, topic: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT vns.create_research_request($1, $2) AS id",
      [key, topic],
    );
    const value = result.rows[0]?.id;
    if (typeof value !== "string") throw new Error("Database did not return a job identifier");
    return value;
  }

  async listRecentResearchJobs(): Promise<ResearchJobSummary[]> {
    const result = await this.pool.query<{
      id: string;
      kind: "research";
      topic: string | null;
      status: ResearchJobSummary["status"];
      deliveryState: ResearchJobSummary["deliveryState"];
      createdAt: Date;
    }>(`
      SELECT j.id::text AS id, j.kind, rr.topic, j.status,
             ob.delivery_state AS "deliveryState", j.created_at AS "createdAt"
      FROM vns.jobs j
      JOIN vns.job_outbox ob ON ob.job_id = j.id
      LEFT JOIN vns.research_requests rr ON rr.job_id = j.id
      WHERE j.kind = 'research'
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT 20
    `);
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      topic: row.topic,
      status: row.status,
      deliveryState: row.deliveryState,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function adminJobsFromEnv(
  auth: AdminAuth | undefined,
  env: NodeJS.ProcessEnv = process.env,
  readSecret: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AdminJobs | undefined {
  if (env.VNS_ADMIN_JOBS_ENABLED === undefined || env.VNS_ADMIN_JOBS_ENABLED === "false") {
    return undefined;
  }
  if (env.VNS_ADMIN_JOBS_ENABLED !== "true" || !auth) {
    throw new Error("Admin jobs require explicit enablement and active admin authentication");
  }
  if (env.VNS_POSTGRES_PASSWORD_FILE !== "/run/secrets/postgres_password") {
    throw new Error("Admin jobs require the PostgreSQL password Docker secret");
  }
  const host = env.VNS_POSTGRES_HOST ?? "postgres";
  const port = Number(env.VNS_POSTGRES_PORT ?? "5432");
  const database = env.VNS_POSTGRES_DB ?? "videonews";
  if (
    !["postgres", "127.0.0.1"].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(database)
  ) {
    throw new Error("Admin jobs require a known PostgreSQL endpoint");
  }
  let password: string;
  try {
    password = readSecret(env.VNS_POSTGRES_PASSWORD_FILE).trimEnd();
  } catch {
    throw new Error("PostgreSQL admin-job secret unavailable");
  }
  if (password.length < 16) {
    throw new Error("PostgreSQL admin-job secret invalid");
  }

  const { Pool } = pg;
  const pool = new Pool({
    host,
    port,
    user: "vns",
    database,
    password,
    max: 2,
    connectionTimeoutMillis: 4000,
    idleTimeoutMillis: 5000,
    statement_timeout: 8000,
  });
  return new AdminJobs(
    auth,
    new PostgresResearchJobStore(pool),
    new AdminEvidence(auth, new PostgresEvidenceReviewStore(pool)),
  );
}
