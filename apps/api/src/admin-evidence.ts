import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { AdminAuth } from "./auth.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECISIONS = ["verified", "disputed", "rejected"] as const;
export function validReviewReason(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  const length = Array.from(value).length;
  return (
    length >= 20 &&
    length <= 500 &&
    !value.split("").some((c) => {
      const code = c.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}
type Decision = (typeof DECISIONS)[number];

export interface EvidenceSummary {
  id: string;
  jobId: string;
  sourceUrl: string;
  publisher: string;
  headline: string;
  claim: string;
  status: "candidate" | Decision;
  reviewedAt: string | null;
}

export interface EvidenceReviewStore {
  list(jobId: string): Promise<EvidenceSummary[]>;
  review(
    evidenceId: string,
    decision: Decision,
    reason: string,
  ): Promise<"updated" | "missing" | "already_reviewed">;
}

export function parseReview(
  value: unknown,
): { evidenceId: string; decision: Decision; reason: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 3 ||
    typeof body.evidenceId !== "string" ||
    !UUID.test(body.evidenceId) ||
    !DECISIONS.some((decision) => decision === body.decision) ||
    !validReviewReason(body.reason)
  )
    return null;
  return { evidenceId: body.evidenceId, decision: body.decision as Decision, reason: body.reason };
}

function validEvidence(value: unknown): value is EvidenceSummary {
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
    ["candidate", ...DECISIONS].includes(row.status as Decision) &&
    (row.reviewedAt === null ||
      (typeof row.reviewedAt === "string" && !Number.isNaN(Date.parse(row.reviewedAt))))
  );
}

async function jsonRequest(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return null;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024) return null;
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function respond(response: ServerResponse, code: number, data: object): void {
  response.writeHead(code);
  response.end(JSON.stringify(data));
}

export class AdminEvidence {
  constructor(
    private readonly auth: AdminAuth,
    private readonly store: EvidenceReviewStore,
    private readonly allowSharedReviews = true,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.auth.hasAdminSession(request)) {
      respond(response, 401, { error: "unauthorized" });
      return;
    }
    const path = request.url?.split("?")[0];
    if (request.method === "GET" && path === "/admin/evidence") {
      let jobId: string | null = null;
      try {
        const parsed = new URL(request.url ?? "", "http://internal.invalid");
        if ([...parsed.searchParams.keys()].length !== 1) {
          respond(response, 400, { error: "invalid_request" });
          return;
        }
        jobId = parsed.searchParams.get("jobId");
      } catch {
        /* Invalid URL is rejected below. */
      }
      if (!jobId || !UUID.test(jobId)) {
        respond(response, 400, { error: "invalid_request" });
        return;
      }
      try {
        const evidence = await this.store.list(jobId);
        if (evidence.length > 20 || !evidence.every(validEvidence)) {
          throw new Error("Invalid source list");
        }
        respond(response, 200, { evidence });
      } catch {
        respond(response, 503, { error: "temporarily_unavailable" });
      }
      return;
    }
    if (request.method === "POST" && path === "/admin/evidence/review") {
      // Once named editor auth is enabled, a shared admin password must never
      // silently bypass personal attribution and role checks.
      if (!this.allowSharedReviews) {
        respond(response, 403, { error: "named_editor_required" });
        return;
      }
      if (!this.auth.originAllowed(request)) {
        respond(response, 403, { error: "forbidden" });
        return;
      }
      const review = parseReview(await jsonRequest(request));
      if (!review) {
        respond(response, 400, { error: "invalid_request" });
        return;
      }
      try {
        const outcome = await this.store.review(review.evidenceId, review.decision, review.reason);
        if (outcome === "missing") respond(response, 404, { error: "not_found" });
        else if (outcome === "already_reviewed")
          respond(response, 409, { error: "already_reviewed" });
        else if (outcome === "updated") respond(response, 200, { reviewed: true });
        else throw new Error("Invalid review outcome");
      } catch {
        respond(response, 503, { error: "temporarily_unavailable" });
      }
      return;
    }
    respond(response, 405, { error: "method_not_allowed" });
  }
}

export class PostgresEvidenceReviewStore implements EvidenceReviewStore {
  constructor(private readonly pool: Pool) {}

  async list(jobId: string): Promise<EvidenceSummary[]> {
    if (!UUID.test(jobId)) throw new Error("Invalid job id");
    const { rows } = await this.pool.query<{
      id: string;
      jobId: string;
      sourceUrl: string;
      publisher: string;
      headline: string;
      claim: string;
      status: EvidenceSummary["status"];
      reviewedAt: Date | null;
    }>(
      `
      SELECT e.id::text AS id, e.job_id::text AS "jobId",
             e.source_url AS "sourceUrl", e.publisher, e.headline,
             e.claim_text AS claim, e.review_status AS status, e.reviewed_at AS "reviewedAt"
      FROM vns.research_evidence e
      JOIN vns.research_requests r ON r.job_id = e.job_id
      WHERE e.job_id = $1::uuid
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 20
    `,
      [jobId],
    );
    return rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      sourceUrl: row.sourceUrl,
      publisher: row.publisher,
      headline: row.headline,
      claim: row.claim,
      status: row.status,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
    }));
  }

  async review(
    evidenceId: string,
    decision: Decision,
    reason: string,
  ): Promise<"updated" | "missing" | "already_reviewed"> {
    if (!UUID.test(evidenceId) || !DECISIONS.includes(decision) || !validReviewReason(reason)) {
      throw new Error("Invalid editorial review");
    }
    // The reviewer field identifies only the authorized shared admin session,
    // NOT an individual person. A named editor identity needs future RBAC.
    const result = await this.pool.query(
      `UPDATE vns.research_evidence
       SET review_status = $2, reviewer = 'admin-session',
           review_reason = $3, reviewed_at = clock_timestamp()
       WHERE id = $1::uuid AND review_status = 'candidate'
       RETURNING id`,
      [evidenceId, decision, reason],
    );
    if (result.rowCount === 1) return "updated";
    const existing = await this.pool.query(
      "SELECT 1 FROM vns.research_evidence WHERE id = $1::uuid",
      [evidenceId],
    );
    return existing.rowCount ? "already_reviewed" : "missing";
  }
}
