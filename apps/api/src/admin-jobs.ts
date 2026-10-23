import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import pg from "pg";
import type { Pool } from "pg";
import type { AdminAuth } from "./auth.js";

const KEY_PATTERN = /^[a-zA-Z0-9_-]{24,80}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ResearchJobStore {
  createResearchJob(key: string): Promise<string>;
  close?(): Promise<void>;
}

export function parseResearchJobRequest(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 2 ||
    body.kind !== "research" ||
    typeof body.idempotencyKey !== "string" ||
    !KEY_PATTERN.test(body.idempotencyKey)
  ) {
    return null;
  }
  return body.idempotencyKey;
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
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.auth.hasAdminSession(request)) {
      respond(response, 401, { error: "unauthorized" });
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
    const key = parseResearchJobRequest(await limitedJson(request));
    if (!key) {
      respond(response, 400, { error: "invalid_request" });
      return;
    }
    try {
      const jobId = await this.store.createResearchJob(key);
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

  async createResearchJob(key: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT vns.create_job_with_outbox('research', $1, NULL, 3) AS id",
      [key],
    );
    const value = result.rows[0]?.id;
    if (typeof value !== "string") throw new Error("Database did not return a job identifier");
    return value;
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
  return new AdminJobs(auth, new PostgresResearchJobStore(pool));
}
