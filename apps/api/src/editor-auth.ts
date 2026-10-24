import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import pg, { type Pool } from "pg";
import { parseReview } from "./admin-evidence.js";
import type { AdminAuth } from "./auth.js";
import type { AdminJobs } from "./admin-jobs.js";

const COOKIE = "__Host-vns_editor";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9_-]{2,31}$/;
const HASH = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
const SESSION_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_ADDRESSES = 512;
const MAX_SESSIONS = 256;
const DUMMY_HASH = "scrypt$" + "0".repeat(32) + "$" + "0".repeat(128);
export type EditorRole = "editor" | "reviewer" | "admin";
export type Verdict = "verified" | "disputed" | "rejected";

export interface EditorAccount {
  id: string;
  username: string;
  role: EditorRole;
  active: boolean;
  passwordHash: string;
  authVersion: number;
}
export interface EditorIdentity {
  id: string;
  username: string;
  role: EditorRole;
  authVersion: number;
}
export type ReviewOutcome = "updated" | "missing" | "already_reviewed" | "forbidden";

export interface EditorStore {
  findAccount(username: string): Promise<EditorAccount | null>;
  activeIdentity(id: string): Promise<EditorIdentity | null>;
  review(
    id: string,
    verdict: Verdict,
    reason: string,
    editorId: string,
    authVersion: number,
  ): Promise<ReviewOutcome>;
  close?(): Promise<void>;
}

interface Session {
  editorId: string;
  authVersion: number;
  expiresAt: number;
}
interface Attempt {
  count: number;
  startedAt: number;
}

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}
function cookieHeader(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function tokenFromRequest(req: IncomingMessage): string | null {
  const matches =
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .filter((x) => x.startsWith(COOKIE + "=")) ?? [];
  if (matches.length !== 1) return null;
  const value = matches[0]?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function credentials(
  req: IncomingMessage,
): Promise<{ username: string; password: string } | null> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 2048) return null;
    chunks.push(bytes);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const row = data as Record<string, unknown>;
    if (
      Object.keys(row).length !== 2 ||
      typeof row.username !== "string" ||
      !NAME.test(row.username) ||
      typeof row.password !== "string" ||
      row.password.length < 12 ||
      row.password.length > 256
    )
      return null;
    return { username: row.username, password: row.password };
  } catch {
    return null;
  }
}

function passwordMatches(password: string, stored: string): boolean {
  const match = HASH.exec(stored) ?? HASH.exec(DUMMY_HASH);
  if (!match?.[1] || !match[2]) throw new Error("Editor auth hash configuration invalid");
  const candidate = scryptSync(password, Buffer.from(match[1], "hex"), 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(candidate, Buffer.from(match[2], "hex")) && HASH.test(stored);
}

export class EditorAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly now: () => number;

  constructor(
    private readonly store: EditorStore,
    private readonly origin: string,
    now?: () => number,
  ) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search ||
      parsed.pathname !== "/"
    ) {
      throw new Error("Editor authentication requires exact HTTPS origin");
    }
    this.now = now ?? Date.now;
  }

  private cleanup(now: number): void {
    for (const [key, value] of this.sessions) {
      if (value.expiresAt <= now) this.sessions.delete(key);
    }
    for (const [key, value] of this.attempts) {
      if (now - value.startedAt >= RATE_WINDOW_MS) this.attempts.delete(key);
    }
  }

  private async identity(req: IncomingMessage): Promise<EditorIdentity | null> {
    const token = tokenFromRequest(req);
    if (!token) return null;
    const key = digest(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    const identity = await this.store.activeIdentity(session.editorId);
    if (
      !identity ||
      !UUID.test(identity.id) ||
      !NAME.test(identity.username) ||
      !Number.isSafeInteger(identity.authVersion) ||
      identity.authVersion !== session.authVersion ||
      !["editor", "reviewer", "admin"].includes(identity.role)
    ) {
      this.sessions.delete(key); // Immediate revocation on next access.
      return null;
    }
    return identity;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = req.url;
    if (
      ![
        "/editor/auth/login",
        "/editor/auth/logout",
        "/editor/auth/session",
        "/editor/me",
        "/editor/evidence/review",
      ].includes(path ?? "")
    )
      return false;

    if (path === "/editor/auth/login" && req.method === "POST") {
      if (req.headers.origin !== this.origin) {
        json(res, 403, { error: "forbidden" });
        return true;
      }
      const address = req.socket.remoteAddress ?? "unknown";
      const now = this.now();
      this.cleanup(now);
      const prior = this.attempts.get(address);
      if (
        (prior && prior.count >= MAX_FAILURES) ||
        (!prior && this.attempts.size >= MAX_ADDRESSES)
      ) {
        json(res, 429, { error: "too_many_requests" });
        return true;
      }
      const input = await credentials(req);
      if (!input) {
        json(res, 400, { error: "invalid_request" });
        return true;
      }
      let account: EditorAccount | null;
      try {
        account = await this.store.findAccount(input.username);
      } catch {
        json(res, 503, { error: "temporarily_unavailable" });
        return true;
      }
      const valid = passwordMatches(input.password, account?.passwordHash ?? DUMMY_HASH);
      if (
        !valid ||
        !account?.active ||
        !UUID.test(account.id) ||
        !Number.isSafeInteger(account.authVersion) ||
        account.authVersion < 0 ||
        !["editor", "reviewer", "admin"].includes(account.role)
      ) {
        this.attempts.set(address, {
          count: (prior?.count ?? 0) + 1,
          startedAt: prior?.startedAt ?? now,
        });
        json(res, 401, { error: "invalid_credentials" });
        return true;
      }
      this.attempts.delete(address);
      if (this.sessions.size >= MAX_SESSIONS) {
        json(res, 503, { error: "session_capacity" });
        return true;
      }
      const token = randomBytes(32).toString("hex");
      this.sessions.set(digest(token), {
        editorId: account.id,
        authVersion: account.authVersion,
        expiresAt: now + SESSION_MS,
      });
      res.setHeader("Set-Cookie", cookieHeader(token, SESSION_MS / 1000));
      json(res, 200, { authenticated: true, role: account.role });
      return true;
    }

    if (path === "/editor/auth/logout" && req.method === "POST") {
      if (req.headers.origin !== this.origin) {
        json(res, 403, { error: "forbidden" });
        return true;
      }
      const token = tokenFromRequest(req);
      if (token) this.sessions.delete(digest(token));
      res.setHeader("Set-Cookie", cookieHeader("", 0));
      json(res, 200, { authenticated: false });
      return true;
    }

    if (path === "/editor/auth/session" && req.method === "GET") {
      const identity = await this.identity(req);
      json(res, 200, {
        authenticated: Boolean(identity),
        ...(identity ? { role: identity.role, username: identity.username } : {}),
      });
      return true;
    }

    if (path === "/editor/me" && req.method === "GET") {
      const identity = await this.identity(req);
      if (!identity) json(res, 401, { error: "unauthorized" });
      else json(res, 200, { username: identity.username, role: identity.role });
      return true;
    }

    if (path === "/editor/evidence/review" && req.method === "POST") {
      const identity = await this.identity(req);
      if (!identity) {
        json(res, 401, { error: "unauthorized" });
        return true;
      }
      if (req.headers.origin !== this.origin) {
        json(res, 403, { error: "forbidden" });
        return true;
      }
      if (identity.role !== "reviewer" && identity.role !== "admin") {
        json(res, 403, { error: "forbidden" });
        return true;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        json(res, 400, { error: "invalid_request" });
        return true;
      }
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 1024) {
          json(res, 400, { error: "invalid_request" });
          return true;
        }
        chunks.push(bytes);
      }
      let review: ReturnType<typeof parseReview> = null;
      try {
        review = parseReview(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        /* Malformed input stays invalid. */
      }
      if (!review) {
        json(res, 400, { error: "invalid_request" });
        return true;
      }
      try {
        const status = await this.store.review(
          review.evidenceId,
          review.decision,
          review.reason,
          identity.id,
          identity.authVersion,
        );
        if (status === "updated") json(res, 200, { reviewed: true });
        else if (status === "already_reviewed") json(res, 409, { error: "already_reviewed" });
        else if (status === "missing") json(res, 404, { error: "not_found" });
        else json(res, 403, { error: "forbidden" });
      } catch {
        json(res, 503, { error: "temporarily_unavailable" });
      }
      return true;
    }

    json(res, 405, { error: "method_not_allowed" });
    return true;
  }

  async close(): Promise<void> {
    this.sessions.clear();
    await this.store.close?.();
  }
}

export class PostgresEditorStore implements EditorStore {
  constructor(private readonly pool: Pool) {}

  async findAccount(username: string): Promise<EditorAccount | null> {
    const result = await this.pool.query<{
      id: string;
      username: string;
      role: EditorRole;
      active: boolean;
      passwordHash: string;
      authVersion: number;
    }>(
      `SELECT id::text, username, role, active, auth_version AS "authVersion",
              password_hash AS "passwordHash"
       FROM vns.editor_accounts WHERE username=$1`,
      [username],
    );
    return result.rows[0] ?? null;
  }

  async activeIdentity(id: string): Promise<EditorIdentity | null> {
    if (!UUID.test(id)) return null;
    const result = await this.pool.query<EditorIdentity>(
      `SELECT id::text, username, role, auth_version AS "authVersion"
       FROM vns.editor_accounts WHERE id=$1::uuid AND active=true`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async review(
    id: string,
    verdict: Verdict,
    reason: string,
    editorId: string,
    authVersion: number,
  ): Promise<ReviewOutcome> {
    if (!UUID.test(id) || !UUID.test(editorId) || !Number.isSafeInteger(authVersion)) {
      throw new Error("Invalid review identity");
    }
    try {
      // A single statement holds the account row lock through its evidence
      // update and audit trigger. Runtime SQL requires only EXECUTE on this
      // narrowly scoped function, not UPDATE on editor_accounts or evidence.
      const result = await this.pool.query<{ outcome: ReviewOutcome }>(
        `SELECT vns.review_evidence_as_editor(
           $1::uuid, $2::text, $3::text, $4::uuid, $5::integer
         ) AS outcome`,
        [id, verdict, reason, editorId, authVersion],
      );
      const outcome = result.rows[0]?.outcome;
      if (
        outcome === "updated" ||
        outcome === "missing" ||
        outcome === "already_reviewed" ||
        outcome === "forbidden"
      ) {
        return outcome;
      }
      throw new Error("Invalid database review outcome");
    } catch {
      throw new Error("Editorial review transaction failed");
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function editorAuthFromEnv(
  adminAuth: AdminAuth | undefined,
  jobs: AdminJobs | undefined,
  env: NodeJS.ProcessEnv = process.env,
  readSecret: (path: string) => string = (path) => readFileSync(path, "utf8"),
): EditorAuth | undefined {
  if (env.VNS_EDITOR_AUTH_ENABLED === undefined || env.VNS_EDITOR_AUTH_ENABLED === "false") {
    return undefined;
  }
  if (
    env.VNS_EDITOR_AUTH_ENABLED !== "true" ||
    !adminAuth ||
    !jobs ||
    env.VNS_POSTGRES_PASSWORD_FILE !== "/run/secrets/postgres_password" ||
    !env.VNS_ADMIN_ORIGIN
  ) {
    throw new Error("Editor authentication requires approved admin/data feature gates");
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
    throw new Error("Editor authentication PostgreSQL endpoint invalid");
  }
  let password: string;
  try {
    password = readSecret(env.VNS_POSTGRES_PASSWORD_FILE).trimEnd();
  } catch {
    throw new Error("Editor authentication PostgreSQL secret unavailable");
  }
  if (password.length < 16) throw new Error("Editor authentication PostgreSQL secret invalid");
  const pool = new pg.Pool({
    host,
    port,
    database,
    user: "vns",
    password,
    max: 2,
    connectionTimeoutMillis: 4000,
    idleTimeoutMillis: 5000,
    statement_timeout: 8000,
  });
  return new EditorAuth(new PostgresEditorStore(pool), env.VNS_ADMIN_ORIGIN);
}
