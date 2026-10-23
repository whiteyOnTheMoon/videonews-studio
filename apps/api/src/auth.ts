import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "__Host-vns_session";
const SESSION_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_ADDRESSES = 512;
const MAX_SESSIONS = 256;
const SCRYPT_N = 16384;
const HASH_PATTERN = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

export type AdminRole = "admin";

export interface AdminAuthConfig {
  passwordHash: string;
  origin: string;
  now?: () => number;
}

interface Session {
  role: AdminRole;
  expiresAt: number;
}

interface Attempt {
  count: number;
  startedAt: number;
}

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

function sessionDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function fromCookie(request: IncomingMessage): string | null {
  const pair = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE + "="));
  const token = pair?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function cookieHeader(token: string, maxAge: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function readPassword(request: IncomingMessage): Promise<string | null> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return null;
  }
  let content = "";
  for await (const chunk of request) {
    content += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(content, "utf8") > 2048) {
      return null;
    }
  }
  try {
    const body: unknown = JSON.parse(content);
    if (
      typeof body === "object" &&
      body !== null &&
      "password" in body &&
      typeof body.password === "string" &&
      body.password.length > 0 &&
      body.password.length <= 1024
    ) {
      return body.password;
    }
  } catch {
    // Never echo untrusted request data into errors or logs.
  }
  return null;
}

export class AdminAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly now: () => number;
  private readonly salt: Buffer;
  private readonly hash: Buffer;
  private readonly origin: string;

  constructor(config: AdminAuthConfig) {
    const match = HASH_PATTERN.exec(config.passwordHash);
    if (!match || !match[1] || !match[2]) {
      throw new Error("Admin auth requires a valid scrypt password hash");
    }
    const url = new URL(config.origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== config.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error("Admin auth requires an exact HTTPS origin");
    }
    this.origin = config.origin;
    this.salt = Buffer.from(match[1], "hex");
    this.hash = Buffer.from(match[2], "hex");
    this.now = config.now ?? Date.now;
  }

  private verifyPassword(password: string): boolean {
    const candidate = scryptSync(password, this.salt, 64, {
      N: SCRYPT_N,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(candidate, this.hash);
  }

  private removeExpired(now: number): void {
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
    for (const [address, attempt] of this.attempts) {
      if (now - attempt.startedAt >= RATE_WINDOW_MS) this.attempts.delete(address);
    }
  }

  private currentSession(request: IncomingMessage): Session | null {
    const token = fromCookie(request);
    if (!token) return null;
    const digest = sessionDigest(token);
    const session = this.sessions.get(digest);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(digest);
      return null;
    }
    return session;
  }

  private originAllowed(request: IncomingMessage): boolean {
    return request.headers.origin === this.origin;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const route = request.url;
    const method = request.method;
    if (
      !["/auth/login", "/auth/logout", "/auth/session", "/admin/me"].includes(route ?? "")
    ) {
      return false;
    }

    if (route === "/auth/login" && method === "POST") {
      if (!this.originAllowed(request)) {
        json(response, 403, { error: "forbidden" });
        return true;
      }

      const address = request.socket.remoteAddress ?? "unknown";
      const now = this.now();
      this.removeExpired(now);
      const attempt = this.attempts.get(address);
      if (
        (attempt && attempt.count >= MAX_FAILURES) ||
        (!attempt && this.attempts.size >= MAX_ADDRESSES)
      ) {
        json(response, 429, { error: "too_many_requests" });
        return true;
      }

      const password = await readPassword(request);
      if (password === null) {
        json(response, 400, { error: "invalid_request" });
        return true;
      }

      if (!this.verifyPassword(password)) {
        this.attempts.set(address, {
          count: (attempt?.count ?? 0) + 1,
          startedAt: attempt?.startedAt ?? now,
        });
        json(response, 401, { error: "invalid_credentials" });
        return true;
      }

      this.attempts.delete(address);
      if (this.sessions.size >= MAX_SESSIONS) {
        json(response, 503, { error: "session_capacity" });
        return true;
      }

      const token = randomBytes(32).toString("hex");
      this.sessions.set(sessionDigest(token), { role: "admin", expiresAt: now + SESSION_MS });
      response.setHeader("Set-Cookie", cookieHeader(token, SESSION_MS / 1000));
      json(response, 200, { authenticated: true, role: "admin" });
      return true;
    }

    if (route === "/auth/logout" && method === "POST") {
      if (!this.originAllowed(request)) {
        json(response, 403, { error: "forbidden" });
        return true;
      }
      const token = fromCookie(request);
      if (token) this.sessions.delete(sessionDigest(token));
      response.setHeader("Set-Cookie", cookieHeader("", 0));
      json(response, 200, { authenticated: false });
      return true;
    }

    if (route === "/auth/session" && method === "GET") {
      const session = this.currentSession(request);
      json(response, 200, {
        authenticated: session !== null,
        ...(session ? { role: session.role } : {}),
      });
      return true;
    }

    if (route === "/admin/me" && method === "GET") {
      const session = this.currentSession(request);
      if (session?.role !== "admin") {
        json(response, 401, { error: "unauthorized" });
      } else {
        json(response, 200, { role: "admin" });
      }
      return true;
    }

    json(response, 405, { error: "method_not_allowed" });
    return true;
  }
}

export function adminAuthFromEnv(env: NodeJS.ProcessEnv): AdminAuth | undefined {
  if (env.VNS_ADMIN_AUTH_ENABLED === undefined || env.VNS_ADMIN_AUTH_ENABLED === "false") {
    return undefined;
  }
  if (env.VNS_ADMIN_AUTH_ENABLED !== "true") {
    throw new Error("Invalid admin auth enabled flag");
  }
  if (!env.VNS_ADMIN_PASSWORD_HASH || !env.VNS_ADMIN_ORIGIN) {
    throw new Error("Admin auth configuration is incomplete");
  }
  return new AdminAuth({
    passwordHash: env.VNS_ADMIN_PASSWORD_HASH,
    origin: env.VNS_ADMIN_ORIGIN,
  });
}
