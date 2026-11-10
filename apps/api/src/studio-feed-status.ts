/** Read-only, separately credentialed evidence from existing P2 BullMQ. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Redis } from "ioredis";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth } from "./editor-auth.js";

const SECRET = "/run/secrets/vns_studio_feed_status_password";
const USERNAME = /^vns_feed_status_[a-z0-9_]{3,24}$/;
const PREFIX = "bull:vns:feed:vns-feed-poll";
const JOB = /^vns-feed-tick-(0|[1-9][0-9]{0,13})$/;
const SLOT_MS = 900_000;
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

export interface FeedJobEvidence {
  completed: string | null;
  failed: string | null;
  returnvalue: string | null;
  exists: number;
}

export interface FeedStatusReader {
  read(jobId: string): Promise<FeedJobEvidence>;
  close?(): Promise<void>;
}

export interface FeedJobSummary {
  sourcesExamined: number;
  candidatesAdded: number;
  notModified: number;
}

function asSummary(raw: string | null): FeedJobSummary | null {
  if (!raw || raw.length > 512) return null;
  try {
    const data: unknown = JSON.parse(raw);
    if (
      data === null ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).sort().join(",") !== "candidatesAdded,notModified,ok,sourcesExamined" ||
      !("ok" in data) ||
      data.ok !== true ||
      !("sourcesExamined" in data) ||
      !("candidatesAdded" in data) ||
      !("notModified" in data)
    )
      return null;
    for (const key of ["sourcesExamined", "candidatesAdded", "notModified"] as const) {
      const value = data[key];
      if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
    }
    if (
      (data.sourcesExamined as number) > 5 ||
      (data.notModified as number) > (data.sourcesExamined as number) ||
      (data.candidatesAdded as number) > 10000
    )
      return null;
    return {
      sourcesExamined: data.sourcesExamined as number,
      candidatesAdded: data.candidatesAdded as number,
      notModified: data.notModified as number,
    };
  } catch {
    return null;
  }
}

function reply(res: ServerResponse, status: number, data: object): void {
  res.writeHead(status, {
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(data));
}

export class StudioFeedStatusService {
  constructor(
    private readonly auth: Pick<AdminAuth, "hasAdminSession">,
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly reader: FeedStatusReader,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!auth || !editor || !reader || typeof reader.read !== "function") {
      throw new Error("Studio feed status ports missing");
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://internal.invalid");
    if (url.pathname !== "/admin/studio-news-status") return false;
    if (req.method !== "GET") {
      reply(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!this.auth.hasAdminSession(req)) {
      reply(res, 401, { error: "unauthorized" });
      return true;
    }
    let editor;
    try {
      editor = await this.editor.authenticatedAdminIdentity(req);
    } catch {
      reply(res, 503, { error: "temporarily_unavailable" });
      return true;
    }
    if (!editor || editor.role !== "admin") {
      reply(res, 403, { error: "forbidden" });
      return true;
    }
    const keys = [...url.searchParams.keys()];
    const jobId = url.searchParams.get("jobId");
    const match = JOB.exec(jobId ?? "");
    const nowMs = this.now().getTime();
    const slot = match ? Number(match[1]) : NaN;
    const slotMs = slot * SLOT_MS;
    if (
      keys.length !== 1 ||
      keys[0] !== "jobId" ||
      !Number.isSafeInteger(slot) ||
      !Number.isSafeInteger(nowMs) ||
      slotMs > nowMs ||
      nowMs - slotMs > MAX_AGE_MS ||
      req.headers["transfer-encoding"] !== undefined
    ) {
      reply(res, 400, { error: "invalid_request" });
      return true;
    }
    try {
      const evidence = await this.reader.read(jobId!);
      const completed = evidence.completed !== null;
      const failed = evidence.failed !== null;
      if (
        (completed && failed) ||
        ![0, 1].includes(evidence.exists) ||
        (evidence.completed !== null && typeof evidence.completed !== "string") ||
        (evidence.failed !== null && typeof evidence.failed !== "string") ||
        (evidence.returnvalue !== null && typeof evidence.returnvalue !== "string")
      )
        throw new Error("Untrusted Redis evidence");
      if (completed) {
        const stamp = Number(evidence.completed);
        const summary = asSummary(evidence.returnvalue);
        if (!summary || !Number.isSafeInteger(stamp) || stamp < slotMs || stamp > nowMs)
          throw new Error("Invalid completed job");
        reply(res, 200, {
          jobId,
          state: "completed",
          finishedAt: new Date(stamp).toISOString(),
          summary,
          publishingAllowed: false,
        });
      } else if (failed) {
        reply(res, 200, {
          jobId,
          state: "failed",
          finishedAt: null,
          summary: null,
          publishingAllowed: false,
        });
      } else {
        reply(res, 200, {
          jobId,
          state: evidence.exists === 1 ? "pending" : "unknown",
          finishedAt: null,
          summary: null,
          publishingAllowed: false,
        });
      }
    } catch {
      reply(res, 503, { error: "temporarily_unavailable" });
    }
    return true;
  }

  close(): Promise<void> {
    return this.reader.close?.() ?? Promise.resolve();
  }
}

function secretFile(): string {
  let fd: number | undefined;
  try {
    fd = openSync(SECRET, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 40 ||
      stat.size > 256 ||
      (typeof process.getuid === "function" && stat.uid !== 0 && stat.uid !== process.getuid())
    )
      throw new Error("Untrusted feed status credential");
    const password = readFileSync(fd, "utf8").trimEnd();
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(password)) {
      throw new Error("Invalid feed status credential");
    }
    return password;
  } catch {
    throw new Error("Feed status credential unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** OFF by default. Only ZSCORE, HGET and EXISTS on fixed queue keys are used. */
export function studioFeedStatusFromEnv(
  auth: AdminAuth | undefined,
  editor: EditorAuth | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StudioFeedStatusService | undefined {
  if (env.VNS_STUDIO_FEED_STATUS_API_ENABLED !== "true") return undefined;
  if (
    !auth ||
    !editor ||
    env.VNS_STUDIO_FEED_STATUS_OPERATOR_ACK !== "true" ||
    env.VNS_STUDIO_FEED_STATUS_REDIS_HOST !== "redis" ||
    !USERNAME.test(env.VNS_STUDIO_FEED_STATUS_REDIS_USER ?? "") ||
    env.VNS_STUDIO_FEED_STATUS_REDIS_PASSWORD_FILE !== SECRET ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false"
  )
    throw new Error("Studio status reader not authorized");
  const redis = new Redis({
    host: "redis",
    port: 6379,
    username: env.VNS_STUDIO_FEED_STATUS_REDIS_USER,
    password: secretFile(),
    lazyConnect: true,
    enableReadyCheck: false,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on("error", () => undefined);
  const reader: FeedStatusReader = {
    async read(jobId) {
      const [completed, failed, returnvalue, exists] = await Promise.all([
        redis.zscore(PREFIX + ":completed", jobId),
        redis.zscore(PREFIX + ":failed", jobId),
        redis.hget(PREFIX + ":" + jobId, "returnvalue"),
        redis.exists(PREFIX + ":" + jobId),
      ]);
      return { completed, failed, returnvalue, exists };
    },
    async close() {
      await redis.quit().catch(() => redis.disconnect());
    },
  };
  return new StudioFeedStatusService(auth, editor, reader);
}
