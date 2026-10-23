import { clientAdminCookie, type AdminProxyConfig } from "./admin-proxy";

export interface ResearchJobOverview {
  id: string;
  kind: "research";
  topic: string | null;
  status: "pending" | "running" | "retry" | "done" | "failed" | "cancelled";
  deliveryState: "pending" | "enqueued";
  createdAt: string;
}

export function isResearchJobOverview(value: unknown): value is ResearchJobOverview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  return (
    Object.keys(job).length === 6 &&
    typeof job.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.id) &&
    job.kind === "research" &&
    (job.topic === null || (typeof job.topic === "string" &&
      job.topic === job.topic.trim() &&
      !/[\u0000-\u001f\u007f]/.test(job.topic) &&
      Array.from(job.topic).length >= 12 && Array.from(job.topic).length <= 160)) &&
    typeof job.status === "string" &&
    ["pending", "running", "retry", "done", "failed", "cancelled"].includes(job.status) &&
    (job.deliveryState === "pending" || job.deliveryState === "enqueued") &&
    typeof job.createdAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(job.createdAt) &&
    !Number.isNaN(Date.parse(job.createdAt))
  );
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

// Never cache private data or relay a raw upstream body. All fields are allowlisted.
export async function adminResearchJobsList(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.method !== "GET") return reply(405, { error: "method_not_allowed" });
  const cookie = clientAdminCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  try {
    const upstream = await fetcher(config.api + "/admin/jobs", {
      method: "GET",
      headers: { Cookie: cookie },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 401) return reply(401, { error: "unauthorized" });
    if (upstream.status !== 200) return reply(503, { error: "temporarily_unavailable" });
    const data: unknown = await upstream.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("jobs" in data) ||
      !Array.isArray(data.jobs) ||
      data.jobs.length > 20 ||
      !data.jobs.every(isResearchJobOverview)
    ) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    const jobs: ResearchJobOverview[] = data.jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      topic: job.topic,
      status: job.status,
      deliveryState: job.deliveryState,
      createdAt: job.createdAt,
    }));
    return reply(200, { jobs });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
