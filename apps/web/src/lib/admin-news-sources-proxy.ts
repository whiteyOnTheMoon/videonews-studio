import type { AdminProxyConfig } from "./admin-proxy";
import { clientEditorCookie, editorProfile, editorProxyConfig } from "./editor-proxy";

interface SourceDraft {
  id: string;
  baseUrl: string;
  access: "rss" | "atom" | "official_api" | "html";
  intervalMinutes: number;
  termsUrl: string;
  usage: "metadata_only" | "reviewed_excerpt";
  licenseNotes: string;
}
interface ManagedSource extends SourceDraft {
  status: "pending" | "approved" | "blocked";
  reviewedAt: string;
}
type SourceCommand =
  | { action: "create_pending" | "replace_pending"; expectedRevision: number; source: SourceDraft }
  | { action: "approve" | "block" | "reopen"; expectedRevision: number; sourceId: string };

const ID = /^[a-z][a-z0-9_-]{2,40}$/;
const SOURCE_FIELDS = [
  "id",
  "baseUrl",
  "access",
  "intervalMinutes",
  "termsUrl",
  "usage",
  "licenseNotes",
];
const SNAPSHOT_FIELDS = [...SOURCE_FIELDS, "status", "reviewedAt"];
const MAX_POST = 4096;

export function sourceAdminProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_SOURCE_REGISTRY_ENABLED !== "true") return null;
  return editorProxyConfig(env);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  return (
    Object.keys(value).length === names.length &&
    names.every((key) => Object.hasOwn(value, key))
  );
}
function safeUrl(value: unknown, slash: boolean): value is string {
  if (typeof value !== "string" || value.length < 18 || value.length > 512) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.toString() === value &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      !url.pathname.includes("%") &&
      (!slash || url.pathname.endsWith("/")) &&
      /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) &&
      !/^(?:[0-9]+\.){3}[0-9]+$/.test(url.hostname) &&
      !["local", "internal", "localhost"].some((suffix) => url.hostname.endsWith("." + suffix))
    );
  } catch {
    return false;
  }
}
function sourceDraft(value: unknown): SourceDraft | null {
  if (!object(value) || !exact(value, SOURCE_FIELDS)) return null;
  if (
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !safeUrl(value.baseUrl, true) ||
    !safeUrl(value.termsUrl, false) ||
    !["rss", "atom", "official_api", "html"].includes(value.access as string) ||
    !Number.isSafeInteger(value.intervalMinutes) ||
    (value.intervalMinutes as number) < 15 ||
    (value.intervalMinutes as number) > 10080 ||
    !["metadata_only", "reviewed_excerpt"].includes(value.usage as string) ||
    typeof value.licenseNotes !== "string" ||
    value.licenseNotes.length < 12 ||
    value.licenseNotes.length > 300 ||
    value.licenseNotes.trim() !== value.licenseNotes ||
    Array.from(value.licenseNotes).some((letter) => letter.charCodeAt(0) < 32)
  ) return null;
  return value as unknown as SourceDraft;
}
export function parseSourceAdminProxyCommand(value: unknown): SourceCommand | null {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  ) return null;
  if (value.action === "create_pending" || value.action === "replace_pending") {
    if (!exact(value, ["action", "expectedRevision", "source"])) return null;
    const source = sourceDraft(value.source);
    return source
      ? { action: value.action, expectedRevision: value.expectedRevision as number, source }
      : null;
  }
  if (
    ["approve", "block", "reopen"].includes(value.action as string) &&
    exact(value, ["action", "expectedRevision", "sourceId"]) &&
    typeof value.sourceId === "string" &&
    ID.test(value.sourceId)
  ) {
    return {
      action: value.action as "approve" | "block" | "reopen",
      expectedRevision: value.expectedRevision as number,
      sourceId: value.sourceId,
    };
  }
  return null;
}
function parseSnapshot(value: unknown): { revision: number; sources: ManagedSource[] } | null {
  if (
    !object(value) ||
    !exact(value, ["revision", "sources"]) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.sources) ||
    value.sources.length > 20
  ) return null;
  const seen = new Set<string>();
  const urls = new Set<string>();
  const sources: ManagedSource[] = [];
  for (const raw of value.sources as unknown[]) {
    if (!object(raw) || !exact(raw, SNAPSHOT_FIELDS)) return null;
    const source = sourceDraft(
      Object.fromEntries(SOURCE_FIELDS.map((field) => [field, raw[field]])),
    );
    if (
      !source ||
      !["pending", "approved", "blocked"].includes(raw.status as string) ||
      typeof raw.reviewedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(raw.reviewedAt) ||
      seen.has(source.id) ||
      urls.has(source.baseUrl)
    ) return null;
    seen.add(source.id);
    urls.add(source.baseUrl);
    sources.push({
      ...source,
      status: raw.status as ManagedSource["status"],
      reviewedAt: raw.reviewedAt,
    });
  }
  return { revision: value.revision as number, sources };
}
function reply(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
async function boundedJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    request.headers.has("content-encoding")
  ) return null;
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_POST)
  ) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_POST) return null;
      chunks.push(value);
    }
    if (declared !== null && Number(declared) !== size) return null;
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const bytes of chunks) {
      buffer.set(bytes, offset);
      offset += bytes.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)) as unknown;
    } finally {
      buffer.fill(0);
    }
  } catch {
    return null;
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Dormant authenticated Next.js BFF. A source can be marked approved here
 * but the worker remains disconnected, so feedActive is ALWAYS false.
 * Backend independently validates the personal admin session and mutation.
 */
export async function dormantSourceAdminProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "GET" && request.method !== "POST") {
    return reply(405, { error: "method_not_allowed" });
  }
  if (request.method === "POST" && request.headers.get("origin") !== config.origin) {
    return reply(403, { error: "forbidden" });
  }
  const cookie = clientEditorCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });

  const profile = await editorProfile(request, config, fetcher);
  if (profile.status === 401) return reply(401, { error: "unauthorized" });
  if (profile.status !== 200) return reply(503, { error: "temporarily_unavailable" });
  const identity: unknown = await profile.json();
  if (!object(identity) || identity.role !== "admin") {
    return reply(403, { error: "forbidden" });
  }

  const command = request.method === "POST"
    ? parseSourceAdminProxyCommand(await boundedJson(request))
    : null;
  if (request.method === "POST" && !command) return reply(400, { error: "invalid_request" });

  try {
    const upstream = await fetcher(config.api + "/admin/news-sources", {
      method: request.method,
      headers: {
        Cookie: cookie,
        ...(command ? { Origin: config.origin, "Content-Type": "application/json" } : {}),
      },
      ...(command ? { body: JSON.stringify(command) } : {}),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 401) return reply(401, { error: "unauthorized" });
    if (upstream.status === 403) return reply(403, { error: "forbidden" });
    if (upstream.status === 409) return reply(409, { error: "revision_conflict" });
    if (upstream.status === 400) return reply(400, { error: "invalid_request" });
    if (upstream.status === 429) return reply(429, { error: "too_many_requests" });
    if (upstream.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const raw = await upstream.text();
    if (raw.length > 16384) return reply(503, { error: "temporarily_unavailable" });
    const value: unknown = JSON.parse(raw);
    if (request.method === "GET") {
      const snapshot = parseSnapshot(value);
      return snapshot ? reply(200, snapshot) : reply(503, { error: "temporarily_unavailable" });
    }
    if (!object(value) || !command || !exact(value, [
      "saved", "revision", "sourceId", "status", "feedActive",
    ])) return reply(503, { error: "temporarily_unavailable" });
    const sourceId = "source" in command ? command.source.id : command.sourceId;
    const expectedStatus =
      command.action === "approve"
        ? "approved"
        : command.action === "block"
          ? "blocked"
          : "pending";
    if (
      value.saved !== true ||
      value.feedActive !== false ||
      value.revision !== command.expectedRevision + 1 ||
      value.sourceId !== sourceId ||
      value.status !== expectedStatus
    ) return reply(503, { error: "temporarily_unavailable" });
    return reply(200, {
      saved: true,
      revision: value.revision,
      sourceId,
      status: expectedStatus,
      feedActive: false,
    });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
