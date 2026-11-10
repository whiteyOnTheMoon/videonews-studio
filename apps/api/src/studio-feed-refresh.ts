/** Opt-in producer-only bridge into the existing reviewed P2 feed queue. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth } from "./editor-auth.js";

const QUEUE = "vns-feed-poll";
const PREFIX = "bull:vns:feed";
const NAME = "feed-tick";
const SLOT_MS = 15 * 60 * 1000;
const PASSWORD_FILE = "/run/secrets/vns_studio_feed_producer_password";
const REDIS_USERNAME = /^vns_feed_producer_[a-z0-9_]{3,24}$/;

export interface FeedProducerPort {
  add(
    name: string,
    data: { kind: string; slot: number },
    options: {
      jobId: string;
      attempts: 1;
      removeOnComplete: false;
      removeOnFail: false;
    },
  ): Promise<unknown>;
}

function reply(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

export function feedSlotAt(now: Date): number {
  const value = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Feed dispatch clock refused");
  }
  return Math.floor(value / SLOT_MS);
}

export class StudioFeedRefreshService {
  constructor(
    private readonly auth: Pick<AdminAuth, "hasAdminSession" | "originAllowed">,
    private readonly editor: Pick<EditorAuth, "authenticatedAdminIdentity">,
    private readonly producer: FeedProducerPort,
    private readonly closePort: () => Promise<void> = async () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!auth || !editor || !producer || typeof producer.add !== "function") {
      throw new Error("Feed refresh dependencies unavailable");
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.url !== "/admin/studio-news-refresh") return false;
    if (req.method !== "POST") {
      reply(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (!this.auth.hasAdminSession(req)) {
      reply(res, 401, { error: "unauthorized" });
      return true;
    }
    let actor: Awaited<ReturnType<EditorAuth["authenticatedAdminIdentity"]>>;
    try {
      actor = await this.editor.authenticatedAdminIdentity(req);
    } catch {
      reply(res, 503, { error: "temporarily_unavailable" });
      return true;
    }
    if (!actor || actor.role !== "admin") {
      reply(res, 403, { error: "forbidden" });
      return true;
    }
    if (
      !this.auth.originAllowed(req) ||
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") ||
      req.headers["transfer-encoding"] !== undefined ||
      req.headers["content-encoding"] !== undefined
    ) {
      reply(res, 403, { error: "forbidden" });
      return true;
    }
    try {
      // Neither a browser URL nor a browser source identity enters the job.
      const slot = feedSlotAt(this.now());
      const queueJobId = "vns-feed-tick-" + slot;
      await this.producer.add(
        NAME,
        { kind: NAME, slot },
        { jobId: queueJobId, attempts: 1, removeOnComplete: false, removeOnFail: false },
      );
      // Queue acceptance is NOT confirmation of any fetched article.
      reply(res, 202, {
        accepted: true,
        queueJobId,
        completed: false,
        publishingAllowed: false,
      });
    } catch {
      reply(res, 503, { error: "temporarily_unavailable" });
    }
    return true;
  }

  close(): Promise<void> {
    return this.closePort();
  }
}

function readPassword(): string {
  let fd: number | undefined;
  try {
    fd = openSync(PASSWORD_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 40 ||
      stat.size > 256 ||
      (typeof process.getuid === "function" && stat.uid !== 0 && stat.uid !== process.getuid())
    ) {
      throw new Error("Invalid feed producer secret");
    }
    const value = readFileSync(fd, "utf8").trimEnd();
    if (!/^[A-Za-z0-9_-]{40,256}$/.test(value)) {
      throw new Error("Invalid feed producer credential");
    }
    return value;
  } catch {
    throw new Error("Feed producer credential unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** OFF by default; no Redis client on ordinary API startup. */
export function studioFeedRefreshFromEnv(
  auth: AdminAuth | undefined,
  editor: EditorAuth | undefined,
  env: NodeJS.ProcessEnv = process.env,
): StudioFeedRefreshService | undefined {
  if (env.VNS_STUDIO_FEED_REFRESH_API_ENABLED !== "true") return undefined;
  if (
    !auth ||
    !editor ||
    env.VNS_STUDIO_FEED_REFRESH_OPERATOR_ACK !== "true" ||
    env.VNS_STUDIO_FEED_REDIS_HOST !== "redis" ||
    !REDIS_USERNAME.test(env.VNS_STUDIO_FEED_REDIS_USER ?? "") ||
    env.VNS_STUDIO_FEED_REDIS_PASSWORD_FILE !== PASSWORD_FILE ||
    env.VNS_FEED_SOURCE_BOOTSTRAP !== "false"
  ) {
    throw new Error("Studio feed producer not authorized");
  }
  const connection = new Redis({
    host: "redis",
    port: 6379,
    username: env.VNS_STUDIO_FEED_REDIS_USER,
    password: readPassword(),
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableReadyCheck: true,
  });
  connection.on("error", () => undefined);
  const producer = new Queue(QUEUE, { connection, prefix: PREFIX });
  return new StudioFeedRefreshService(auth, editor, producer, async () => {
    await producer.close();
    await connection.quit().catch(() => connection.disconnect());
  });
}
