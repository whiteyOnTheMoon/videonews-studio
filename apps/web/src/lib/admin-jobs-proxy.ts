import { adminProxyConfig, clientAdminCookie, type AdminProxyConfig } from "./admin-proxy";

export function adminJobsProxyConfig(
  env: Record<string, string | undefined>,
): AdminProxyConfig | null {
  if (env.VNS_WEB_ADMIN_JOBS_ENABLED !== "true") return null;
  return adminProxyConfig(env);
}

function reply(status: number, body: object): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

async function readResearchRequest(request: Request): Promise<string | null> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const object = data as Record<string, unknown>;
    if (
      Object.keys(object).length !== 3 ||
      object.kind !== "research" ||
      typeof object.idempotencyKey !== "string" ||
      !/^[a-zA-Z0-9_-]{24,80}$/.test(object.idempotencyKey) ||
      typeof object.topic !== "string" ||
      object.topic !== object.topic.trim() ||
      /[\u0000-\u001f\u007f]/.test(object.topic) ||
      Array.from(object.topic).length < 12 ||
      Array.from(object.topic).length > 160
    )
      return null;
    return JSON.stringify({
      kind: "research",
      idempotencyKey: object.idempotencyKey,
      topic: object.topic,
    });
  } catch {
    return null;
  }
}

export async function adminResearchJobProxy(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (request.headers.get("origin") !== config.origin) {
    return reply(403, { error: "forbidden" });
  }
  const cookie = clientAdminCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  const body = await readResearchRequest(request);
  if (body === null) return reply(400, { error: "invalid_request" });

  try {
    const upstream = await fetcher(config.api + "/admin/jobs", {
      method: "POST",
      headers: {
        Origin: config.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 202) {
      const data: unknown = await upstream.json();
      if (
        typeof data !== "object" ||
        data === null ||
        !("accepted" in data) ||
        data.accepted !== true ||
        !("jobId" in data) ||
        typeof data.jobId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.jobId)
      )
        return reply(503, { error: "temporarily_unavailable" });
      return reply(202, { accepted: true, jobId: data.jobId });
    }
    if (upstream.status === 409) return reply(409, { error: "idempotency_conflict" });
    if (upstream.status === 401) return reply(401, { error: "unauthorized" });
    if (upstream.status === 403) return reply(403, { error: "forbidden" });
    if (upstream.status === 400) return reply(400, { error: "invalid_request" });
    return reply(503, { error: "temporarily_unavailable" });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
