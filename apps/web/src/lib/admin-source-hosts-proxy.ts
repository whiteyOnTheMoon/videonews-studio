import type { AdminProxyConfig } from "./admin-proxy";
import { sourceAdminProxyConfig } from "./admin-news-sources-proxy";
import { clientEditorCookie, editorProfile } from "./editor-proxy";

export interface HostApprovalCommand {
  action: "grant" | "revoke";
  expectedRevision: number;
  expectedSourceRevision: number;
  host: string;
  reason: string;
}
export interface HostApprovalView {
  revision: number;
  approvedHosts: string[];
  feedActive: false;
}

const MAX_BODY = 1024;
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every((key) => Object.hasOwn(value, key));
}
export function validApprovalHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 253 || !HOST.test(value)) {
    return false;
  }
  if (/\.(?:localhost|local|internal|onion)$/.test(value)) return false;
  return value.split(".").every((part) =>
    part.length <= 63 &&
    !part.startsWith("-") &&
    !part.endsWith("-") &&
    !part.startsWith("xn--"),
  );
}
export function parseHostApprovalCommand(value: unknown): HostApprovalCommand | null {
  if (
    !object(value) ||
    !exact(value, ["action", "expectedRevision", "expectedSourceRevision", "host", "reason"]) ||
    (value.action !== "grant" && value.action !== "revoke") ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !Number.isSafeInteger(value.expectedSourceRevision) ||
    (value.expectedSourceRevision as number) < 1 ||
    !validApprovalHost(value.host) ||
    typeof value.reason !== "string" ||
    value.reason.length < 20 ||
    value.reason.length > 300 ||
    value.reason.trim() !== value.reason ||
    [...value.reason].some((letter) => letter.charCodeAt(0) < 32)
  ) return null;
  return {
    action: value.action,
    expectedRevision: value.expectedRevision as number,
    expectedSourceRevision: value.expectedSourceRevision as number,
    host: value.host,
    reason: value.reason,
  };
}
export function parseHostApprovalView(value: unknown): HostApprovalView | null {
  if (
    !object(value) ||
    !exact(value, ["revision", "approvedHosts", "feedActive"]) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    value.feedActive !== false ||
    !Array.isArray(value.approvedHosts) ||
    value.approvedHosts.length > 5
  ) return null;
  const hosts: string[] = [];
  for (const item of value.approvedHosts as unknown[]) {
    if (!validApprovalHost(item) || hosts.includes(item)) return null;
    hosts.push(item);
  }
  if (hosts.some((host, index) => index > 0 && host <= (hosts[index - 1] ?? ""))) return null;
  return { revision: value.revision as number, approvedHosts: hosts, feedActive: false };
}
export function hostApprovalProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_HOST_APPROVAL_ENABLED !== "true") return null;
  return sourceAdminProxyConfig(env);
}
function respond(status: number, payload: object): Response {
  return Response.json(payload, {
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
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers.has("content-encoding")
  ) return null;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY)) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) return null;
      chunks.push(value);
    }
    if (declared !== null && Number(declared) !== length) return null;
    const raw = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    } finally {
      raw.fill(0);
    }
  } catch {
    return null;
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
    await reader.cancel().catch(() => undefined);
  }
}

/** Default off. Independently rechecks personal editor role before proxying. */
export async function dormantHostApprovalProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return respond(404, { error: "not_found" });
  if (!["GET", "POST"].includes(request.method)) {
    return respond(405, { error: "method_not_allowed" });
  }
  if (request.method === "POST" && request.headers.get("origin") !== config.origin) {
    return respond(403, { error: "forbidden" });
  }
  const cookie = clientEditorCookie(request.headers.get("cookie"));
  if (!cookie) return respond(401, { error: "unauthorized" });
  try {
    const profile = await editorProfile(request, config, fetcher);
    if (profile.status === 401) return respond(401, { error: "unauthorized" });
    if (profile.status !== 200) return respond(503, { error: "temporarily_unavailable" });
    const identity: unknown = await profile.json();
    if (!object(identity) || identity.role !== "admin") {
      return respond(403, { error: "forbidden" });
    }
    const command = request.method === "POST"
      ? parseHostApprovalCommand(await boundedJson(request))
      : null;
    if (request.method === "POST" && !command) {
      return respond(400, { error: "invalid_request" });
    }
    const upstream = await fetcher(config.api + "/admin/source-hosts", {
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
    if (upstream.status === 401) return respond(401, { error: "unauthorized" });
    if (upstream.status === 403) return respond(403, { error: "forbidden" });
    if (upstream.status === 409) return respond(409, { error: "revision_conflict" });
    if (upstream.status === 400) return respond(400, { error: "invalid_request" });
    if (upstream.status === 429) return respond(429, { error: "too_many_requests" });
    if (upstream.status !== 200) return respond(503, { error: "temporarily_unavailable" });
    const contentLength = upstream.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > 2048) {
      return respond(503, { error: "temporarily_unavailable" });
    }
    const raw = await upstream.text();
    if (raw.length > 2048) return respond(503, { error: "temporarily_unavailable" });
    const value: unknown = JSON.parse(raw);
    if (request.method === "GET") {
      const state = parseHostApprovalView(value);
      return state ? respond(200, state) : respond(503, { error: "temporarily_unavailable" });
    }
    if (
      !command ||
      !object(value) ||
      !exact(value, ["saved", "host", "action", "revision", "feedActive"]) ||
      value.saved !== true ||
      value.host !== command.host ||
      value.action !== command.action ||
      value.revision !== command.expectedRevision + 1 ||
      value.feedActive !== false
    ) {
      return respond(503, { error: "temporarily_unavailable" });
    }
    return respond(200, {
      saved: true,
      host: command.host,
      action: command.action,
      revision: command.expectedRevision + 1,
      feedActive: false,
    });
  } catch {
    return respond(503, { error: "temporarily_unavailable" });
  }
}
