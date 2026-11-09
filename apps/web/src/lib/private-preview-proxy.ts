import { clientAdminCookie, isAdminAuthorized, type AdminProxyConfig } from "./admin-proxy";
import { clientEditorCookie, editorProfile, editorProxyConfig } from "./editor-proxy";

const FILE = /^earth-climate-explained-ozone-2026-en-\d{8}-\d{6}-[a-f0-9]{8}\.mp4$/;
const MAX_BYTES = 80 * 1024 * 1024;
type PreviewAction = "list" | "status" | "render" | "file";

export function privatePreviewProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_PRIVATE_PREVIEWS_ENABLED !== "true") return null;
  return editorProxyConfig(env);
}

function reply(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function validListing(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    Object.keys(object).sort().join(",") === "files,private" &&
    object.private === true &&
    Array.isArray(object.files) &&
    object.files.length <= 50 &&
    object.files.every((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const row = entry as Record<string, unknown>;
      return (
        Object.keys(row).sort().join(",") ===
          "bytes,file,modifiedAt,publishingAllowed,reviewRequired" &&
        typeof row.file === "string" &&
        FILE.test(row.file) &&
        typeof row.bytes === "number" &&
        Number.isSafeInteger(row.bytes) &&
        row.bytes > 100000 &&
        row.bytes <= MAX_BYTES &&
        typeof row.modifiedAt === "string" &&
        Number.isFinite(Date.parse(row.modifiedAt)) &&
        new Date(row.modifiedAt).toISOString() === row.modifiedAt &&
        row.reviewRequired === true &&
        row.publishingAllowed === false
      );
    })
  );
}

function validStatus(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(",") === "file,finishedAt,id,publishingAllowed,startedAt,state" &&
    row.publishingAllowed === false &&
    ["idle", "running", "completed", "failed"].includes(row.state as string) &&
    typeof row.id === "string" &&
    (row.id === "" || /^[a-f0-9-]{36}$/.test(row.id)) &&
    typeof row.startedAt === "string" &&
    (row.startedAt === "" || Number.isFinite(Date.parse(row.startedAt))) &&
    (row.finishedAt === null || typeof row.finishedAt === "string") &&
    (row.file === null || (typeof row.file === "string" && FILE.test(row.file)))
  );
}

export async function privatePreviewProxy(
  request: Request,
  action: PreviewAction,
  config: AdminProxyConfig | null,
  file?: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  const method = action === "render" ? "POST" : "GET";
  if (request.method !== method) return reply(405, { error: "method_not_allowed" });
  if (action === "render" && request.headers.get("origin") !== config.origin) {
    return reply(403, { error: "forbidden" });
  }
  if (action === "file" && (!file || !FILE.test(file))) return reply(404, { error: "not_found" });
  const url = new URL(request.url);
  if (action !== "file" && url.search !== "") return reply(400, { error: "invalid_request" });
  if (action === "file" && url.search !== "" && url.search !== "?download=1") {
    return reply(400, { error: "invalid_request" });
  }
  const adminCookie = clientAdminCookie(request.headers.get("cookie"));
  const editorCookie = clientEditorCookie(request.headers.get("cookie"));
  if (!adminCookie || !editorCookie) return reply(401, { error: "unauthorized" });
  if (!(await isAdminAuthorized(config, adminCookie, fetcher))) {
    return reply(401, { error: "unauthorized" });
  }
  const profile = await editorProfile(request, config, fetcher);
  if (profile.status === 401) return reply(401, { error: "unauthorized" });
  if (profile.status !== 200) return reply(503, { error: "temporarily_unavailable" });
  const actor: unknown = await profile.json();
  if (!actor || typeof actor !== "object" || !("role" in actor) || actor.role !== "admin") {
    return reply(403, { error: "forbidden" });
  }
  if (action === "render" && process.env.VNS_WEB_PRIVATE_PREVIEW_RENDER_ENABLED !== "true") {
    return reply(403, { error: "render_disabled" });
  }

  const path =
    action === "list"
      ? "/admin/private-previews"
      : action === "status"
        ? "/admin/private-previews/status"
        : action === "render"
          ? "/admin/private-previews/render"
          : "/admin/private-previews/" + file + url.search;
  const headers: Record<string, string> = { Cookie: editorCookie };
  if (action === "render") {
    headers.Origin = config.origin;
    headers["Content-Type"] = "application/json";
  }
  if (action === "file" && request.headers.has("range")) {
    const range = request.headers.get("range") ?? "";
    if (!/^bytes=\d+-\d*$/.test(range)) return reply(416, { error: "invalid_range" });
    headers.Range = range;
  }
  try {
    const upstream = await fetcher(config.api + path, {
      method,
      headers,
      ...(action === "render"
        ? { body: JSON.stringify({ storyId: "ozone-2026-explained-en" }) }
        : {}),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(action === "file" ? 30_000 : 5000),
    });
    if ([401, 403, 404, 405, 409, 416].includes(upstream.status)) {
      return reply(upstream.status, { error: "request_refused" });
    }
    if (action === "file") {
      if (
        ![200, 206].includes(upstream.status) ||
        upstream.headers.get("content-type") !== "video/mp4" ||
        !upstream.body
      ) {
        await upstream.body?.cancel();
        return reply(503, { error: "temporarily_unavailable" });
      }
      const length = upstream.headers.get("content-length");
      if (!length || !/^\d+$/.test(length) || Number(length) < 1 || Number(length) > MAX_BYTES) {
        await upstream.body.cancel();
        return reply(503, { error: "temporarily_unavailable" });
      }
      const output = new Headers({
        "Content-Type": "video/mp4",
        "Content-Length": length,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Disposition":
          (url.search === "?download=1" ? "attachment" : "inline") + '; filename="' + file + '"',
      });
      if (upstream.status === 206) {
        const contentRange = upstream.headers.get("content-range");
        if (!contentRange || !/^bytes \d+-\d+\/\d+$/.test(contentRange)) {
          await upstream.body.cancel();
          return reply(503, { error: "temporarily_unavailable" });
        }
        output.set("Content-Range", contentRange);
      }
      return new Response(upstream.body, { status: upstream.status, headers: output });
    }
    const status = action === "render" ? 202 : 200;
    if (upstream.status !== status) return reply(503, { error: "temporarily_unavailable" });
    const raw = await upstream.text();
    if (raw.length > 20_000) return reply(503, { error: "temporarily_unavailable" });
    const value: unknown = JSON.parse(raw);
    if (action === "list" && !validListing(value))
      return reply(503, { error: "temporarily_unavailable" });
    if (action === "status" && !validStatus(value))
      return reply(503, { error: "temporarily_unavailable" });
    if (
      action === "render" &&
      (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "accepted,jobId,publishingAllowed" ||
        !("accepted" in value) ||
        value.accepted !== true ||
        !("publishingAllowed" in value) ||
        value.publishingAllowed !== false ||
        !("jobId" in value) ||
        typeof value.jobId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.jobId))
    )
      return reply(503, { error: "temporarily_unavailable" });
    return reply(status, value as object);
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
