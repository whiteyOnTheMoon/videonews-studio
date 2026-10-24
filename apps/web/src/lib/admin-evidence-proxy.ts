import { clientAdminCookie, type AdminProxyConfig } from "./admin-proxy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECISIONS = ["verified", "disputed", "rejected"] as const;

function reply(code: number, body: object): Response {
  return Response.json(body, {
    status: code,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function validateEvidence(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 8 &&
    typeof row.id === "string" &&
    UUID.test(row.id) &&
    typeof row.jobId === "string" &&
    UUID.test(row.jobId) &&
    typeof row.sourceUrl === "string" &&
    row.sourceUrl.startsWith("https://") &&
    row.sourceUrl.length <= 512 &&
    typeof row.publisher === "string" &&
    row.publisher.length <= 120 &&
    typeof row.headline === "string" &&
    row.headline.length <= 200 &&
    typeof row.claim === "string" &&
    row.claim.length <= 280 &&
    ["candidate", ...DECISIONS].includes(row.status as string) &&
    (row.reviewedAt === null ||
      (typeof row.reviewedAt === "string" && !Number.isNaN(Date.parse(row.reviewedAt))))
  );
}

async function requestReviewBody(request: Request): Promise<string | null> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  let count = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > 512) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (
      Object.keys(row).length !== 3 ||
      typeof row.evidenceId !== "string" ||
      !UUID.test(row.evidenceId) ||
      !DECISIONS.some((decision) => decision === row.decision) ||
      typeof row.reason !== "string" ||
      row.reason !== row.reason.trim() ||
      Array.from(row.reason).length < 20 ||
      Array.from(row.reason).length > 500 ||
      row.reason.split("").some((c) => {
        const code = c.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      return null;
    return JSON.stringify({
      evidenceId: row.evidenceId,
      decision: row.decision,
      reason: row.reason,
    });
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function listAdminEvidence(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length !== 1 || !UUID.test(params.get("jobId") ?? "")) {
    return reply(400, { error: "invalid_request" });
  }
  const cookie = clientAdminCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  try {
    const upstream = await fetcher(config.api + "/admin/evidence?jobId=" + params.get("jobId"), {
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
      !("evidence" in data) ||
      !Array.isArray(data.evidence) ||
      data.evidence.length > 20 ||
      !data.evidence.every(validateEvidence)
    ) {
      return reply(503, { error: "temporarily_unavailable" });
    }
    return reply(200, {
      evidence: data.evidence.map((row) => ({
        id: row.id,
        jobId: row.jobId,
        sourceUrl: row.sourceUrl,
        publisher: row.publisher,
        headline: row.headline,
        claim: row.claim,
        status: row.status,
        reviewedAt: row.reviewedAt,
      })),
    });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}

export async function submitAdminEvidenceReview(
  request: Request,
  config: AdminProxyConfig | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (!config) return reply(404, { error: "not_found" });
  if (request.headers.get("origin") !== config.origin) {
    return reply(403, { error: "forbidden" });
  }
  const cookie = clientAdminCookie(request.headers.get("cookie"));
  if (!cookie) return reply(401, { error: "unauthorized" });
  const body = await requestReviewBody(request);
  if (!body) return reply(400, { error: "invalid_request" });
  try {
    const upstream = await fetcher(config.api + "/admin/evidence/review", {
      method: "POST",
      headers: { Cookie: cookie, Origin: config.origin, "Content-Type": "application/json" },
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    if (upstream.status === 200) return reply(200, { reviewed: true });
    if (upstream.status === 401) return reply(401, { error: "unauthorized" });
    if (upstream.status === 403) return reply(403, { error: "forbidden" });
    if (upstream.status === 409) return reply(409, { error: "already_reviewed" });
    if (upstream.status === 404) return reply(404, { error: "not_found" });
    return reply(503, { error: "temporarily_unavailable" });
  } catch {
    return reply(503, { error: "temporarily_unavailable" });
  }
}
