/**
 * P4-10 — private operator preview service.
 * Default OFF. Only named active admin sessions can list, watch or request
 * the fixed, unpublishable English pilot. Never serves a public static path.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fileConstants, createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { EditorAuth } from "./editor-auth.js";

const ROOT = "/home/ap/videonews-previews";
const APP_ROOT = "/home/ap/www/videonews-studio";
const SCRIPT = "scripts/vps_p3_explained_preview.mjs";
const FILE = /^earth-climate-explained-ozone-2026-en-\d{8}-\d{6}-[0-9a-f]{8}\.mp4$/;
const MAX_BYTES = 80 * 1024 * 1024;
const MIN_BYTES = 100000;
const MAX_CAPTURE = 8192;
const MAX_RENDER_MS = 12 * 60 * 1000;
const MIN_RENDER_INTERVAL_MS = 60 * 1000;

interface PrivatePreviewRow {
  file: string;
  bytes: number;
  modifiedAt: string;
  reviewRequired: true;
  publishingAllowed: false;
}
type RenderState = "idle" | "running" | "completed" | "failed";
interface RenderJob {
  id: string;
  state: RenderState;
  startedAt: string;
  finishedAt: string | null;
  file: string | null;
}

function reply(res: ServerResponse, status: number, value: object): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
}

async function safeRoot(): Promise<boolean> {
  try {
    const info = await lstat(ROOT);
    return (
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      (await realpath(ROOT)) === ROOT &&
      (info.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}

async function readFileRows(): Promise<PrivatePreviewRow[]> {
  if (!(await safeRoot())) throw new Error("Private storage unavailable");
  const entries = await readdir(ROOT, { withFileTypes: true });
  const rows: PrivatePreviewRow[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !FILE.test(entry.name)) continue;
    try {
      const handle = await open(
        join(ROOT, entry.name),
        fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.size < MIN_BYTES ||
          info.size > MAX_BYTES ||
          (info.mode & 0o077) !== 0
        )
          continue;
        rows.push({
          file: entry.name,
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          reviewRequired: true,
          publishingAllowed: false,
        });
      } finally {
        await handle.close();
      }
    } catch {
      // An invalid or changing entry is simply hidden.
    }
  }
  rows.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.file.localeCompare(a.file));
  return rows.slice(0, 50);
}

async function readBody(req: IncomingMessage): Promise<boolean> {
  if (
    req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" ||
    req.headers["content-encoding"]
  )
    return false;
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const part of req) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += bytes.length;
    if (length > 512) return false;
    chunks.push(bytes);
  }
  try {
    const row: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return (
      typeof row === "object" &&
      row !== null &&
      !Array.isArray(row) &&
      Object.keys(row).length === 1 &&
      "storyId" in row &&
      row.storyId === "ozone-2026-explained-en"
    );
  } catch {
    return false;
  }
}

export class PrivatePreviewService {
  private job: RenderJob = {
    id: "",
    state: "idle",
    startedAt: "",
    finishedAt: null,
    file: null,
  };
  private child: ChildProcess | null = null;
  private lastStartedMs = 0;

  constructor(
    private readonly editor: EditorAuth,
    private readonly origin: string,
    private readonly createEnabled: boolean,
  ) {
    if (origin !== new URL(origin).origin || !origin.startsWith("https://")) {
      throw new Error("Preview service requires fixed HTTPS origin");
    }
  }

  private launch(): void {
    if (this.child) throw new Error("Render already running");
    const id = randomUUID();
    this.job = {
      id,
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      file: null,
    };
    this.lastStartedMs = Date.now();
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: APP_ROOT,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        VNS_VPS_PREVIEW_APPROVED: "PRIVATE_REVIEW_ONLY",
      },
    });
    this.child = child;
    let output = "";
    let outputSize = 0;
    const capture = (chunk: Buffer) => {
      outputSize += chunk.byteLength;
      if (outputSize <= MAX_CAPTURE) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", (chunk: Buffer) => {
      outputSize += chunk.byteLength;
    });
    const deadline = setTimeout(() => child.kill("SIGTERM"), MAX_RENDER_MS);
    deadline.unref();
    let settled = false;
    const done = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      this.child = null;
      const result = /VNS_PRIVATE_PREVIEW_PATH=\/home\/ap\/videonews-previews\/([^\n\r]+)/.exec(
        output,
      );
      this.job = {
        ...this.job,
        state: success && result && FILE.test(result[1] ?? "") ? "completed" : "failed",
        finishedAt: new Date().toISOString(),
        file: success && result && FILE.test(result[1] ?? "") ? (result[1] ?? null) : null,
      };
    };
    child.on("close", (code) => done(code === 0 && outputSize <= MAX_CAPTURE));
    child.on("error", () => done(false));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? "";
    const list = url === "/admin/private-previews";
    const status = url === "/admin/private-previews/status";
    const render = url === "/admin/private-previews/render";
    const match = /^\/admin\/private-previews\/([^/?]+)(?:\?download=1)?$/.exec(url);
    if (!list && !status && !render && !match) return false;
    if ((list || status || (match && !render)) && req.method !== "GET") {
      reply(res, 405, { error: "method_not_allowed" });
      return true;
    }
    if (render && req.method !== "POST") {
      reply(res, 405, { error: "method_not_allowed" });
      return true;
    }
    const admin = await this.editor.authenticatedAdminIdentity(req);
    if (!admin) {
      reply(res, 401, { error: "unauthorized" });
      return true;
    }
    if (list) {
      try {
        reply(res, 200, { files: await readFileRows(), private: true });
      } catch {
        reply(res, 503, { error: "temporarily_unavailable" });
      }
      return true;
    }
    if (status) {
      reply(res, 200, { ...this.job, publishingAllowed: false });
      return true;
    }
    if (render) {
      if (!this.createEnabled) {
        reply(res, 403, { error: "render_disabled" });
        return true;
      }
      if (req.headers.origin !== this.origin || !(await readBody(req))) {
        reply(res, 400, { error: "invalid_request" });
        return true;
      }
      if (!(await safeRoot())) {
        reply(res, 503, { error: "private_storage_unavailable" });
        return true;
      }
      if (this.child || Date.now() - this.lastStartedMs < MIN_RENDER_INTERVAL_MS) {
        reply(res, 409, { error: "render_busy" });
        return true;
      }
      try {
        this.launch();
        reply(res, 202, { accepted: true, jobId: this.job.id, publishingAllowed: false });
      } catch {
        reply(res, 503, { error: "render_failed_to_start" });
      }
      return true;
    }
    const raw = match?.[1] ?? "";
    if (!FILE.test(raw)) {
      reply(res, 404, { error: "not_found" });
      return true;
    }
    if (!(await safeRoot())) {
      reply(res, 503, { error: "temporarily_unavailable" });
      return true;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(join(ROOT, raw), fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size < MIN_BYTES ||
        info.size > MAX_BYTES ||
        (info.mode & 0o077) !== 0
      ) {
        await handle.close();
        reply(res, 404, { error: "not_found" });
        return true;
      }
      const range = req.headers.range;
      let start = 0;
      let end = info.size - 1;
      if (range !== undefined) {
        const parsed = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!parsed) {
          await handle.close();
          reply(res, 416, { error: "invalid_range" });
          return true;
        }
        start = Number(parsed[1]);
        end = parsed[2] === "" ? end : Number(parsed[2]);
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= info.size ||
          end >= info.size
        ) {
          await handle.close();
          reply(res, 416, { error: "invalid_range" });
          return true;
        }
      }
      res.writeHead(range === undefined ? 200 : 206, {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        ...(range === undefined ? {} : { "Content-Range": `bytes ${start}-${end}/${info.size}` }),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition":
          (url.endsWith("?download=1") ? "attachment" : "inline") + '; filename="' + raw + '"',
      });
      const streamHandle = handle;
      const video = createReadStream(join(ROOT, raw), {
        fd: streamHandle.fd,
        autoClose: false,
        start,
        end,
      });
      video.on("error", () => res.destroy());
      res.on("close", () => video.destroy());
      video.on("close", () => void streamHandle.close().catch(() => undefined));
      video.pipe(res);
    } catch {
      if (handle) await handle.close().catch(() => undefined);
      if (!res.headersSent) reply(res, 404, { error: "not_found" });
      else res.destroy();
    }
    return true;
  }
}

export function privatePreviewServiceFromEnv(
  editor: EditorAuth | undefined,
  env: Record<string, string | undefined>,
): PrivatePreviewService | undefined {
  if (env.VNS_PRIVATE_PREVIEWS_API_ENABLED !== "true" || !editor) return undefined;
  if (env.VNS_PRIVATE_PREVIEWS_ROOT !== ROOT) return undefined;
  if (!env.VNS_ADMIN_ORIGIN) return undefined;
  const createEnabled =
    env.VNS_PRIVATE_PREVIEWS_RENDER_ENABLED === "true" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0 &&
    process.env.USER === "ap";
  return new PrivatePreviewService(editor, env.VNS_ADMIN_ORIGIN, createEnabled);
}
