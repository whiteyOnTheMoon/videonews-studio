import type { Job } from "bullmq";
import type { Pool } from "pg";
import { makeSourceCandidate, type SourceCandidate } from "./source-policy.js";
import type { SourceDocument } from "./source-fetch.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ResearchCandidateProvider {
  // No real discovery provider is wired in production. CI injects curated
  // fixtures; a future provider must go through separate editorial review.
  discover(topic: string): Promise<unknown>;
}

export interface ResearchFetchPort {
  fetch(sourceUrl: string): Promise<SourceDocument>;
}

export interface ResearchEvidenceStore {
  loadResearchTopic(jobId: string): Promise<string | null>;
  saveCandidate(jobId: string, candidate: SourceCandidate, document: SourceDocument): Promise<void>;
}

export interface ResearchProcessorResult {
  candidatesRecorded: number;
  needsEditorialReview: true;
}

/**
 * Constructible only with explicitly supplied discovery, fetch and storage
 * ports. Does not connect to the web, Redis or PostgreSQL by itself, and is
 * not installed as the default/probe worker handler.
 */
export function createResearchProcessor(
  store: ResearchEvidenceStore,
  discovery: ResearchCandidateProvider,
  fetcher: ResearchFetchPort,
): (job: Job) => Promise<ResearchProcessorResult> {
  return async (job) => {
    if (
      job.name !== "research" ||
      typeof job.id !== "string" ||
      typeof job.data !== "object" ||
      job.data === null ||
      Object.keys(job.data).length !== 2 ||
      job.data.kind !== "research" ||
      typeof job.data.jobId !== "string" ||
      !UUID.test(job.data.jobId) ||
      job.id !== "job-" + job.data.jobId.replaceAll("-", "")
    ) {
      throw new Error("Unrecognized research queue job");
    }
    const id: string = job.data.jobId;
    const topic = await store.loadResearchTopic(id);
    if (typeof topic !== "string" || topic.length < 12 || topic.length > 160) {
      throw new Error("Research job has no approved topic");
    }
    const raw: unknown = await discovery.discover(topic);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) {
      throw new Error("Research source count outside approved bounds");
    }
    const candidates = raw.map((value) => makeSourceCandidate(value));
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.sourceUrl, candidate.claim]);
      if (seen.has(key)) throw new Error("Duplicate research source candidate");
      seen.add(key);
    }
    let recorded = 0;
    for (const candidate of candidates) {
      const document = await fetcher.fetch(candidate.sourceUrl);
      if (
        document.sourceUrl !== candidate.sourceUrl ||
        !/^[0-9a-f]{64}$/.test(document.sha256) ||
        typeof document.text !== "string" ||
        typeof document.mediaType !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(document.fetchedAt) ||
        Number.isNaN(Date.parse(document.fetchedAt))
      ) {
        throw new Error("Source retrieval metadata is invalid");
      }
      // Note: mere retrieval does NOT verify the candidate claim, and the
      // fetched page body is not persisted or promoted to instructions.
      await store.saveCandidate(id, candidate, document);
      recorded += 1;
    }
    return { candidatesRecorded: recorded, needsEditorialReview: true };
  };
}

/**
 * Idempotent storage for source candidates. Re-running a stalled BullMQ job
 * must never replace a previous claim or promote it to verified. Use the
 * database unique (job_id, source_url, claim_text) constraint.
 */
export class PostgresResearchEvidenceStore implements ResearchEvidenceStore {
  constructor(private readonly pool: Pool) {}

  async loadResearchTopic(jobId: string): Promise<string | null> {
    if (!UUID.test(jobId)) throw new Error("Invalid research job ID");
    const result = await this.pool.query<{ topic: string }>(
      `SELECT rr.topic
       FROM vns.research_requests rr
       JOIN vns.jobs j ON j.id = rr.job_id
       WHERE rr.job_id = $1::uuid
         AND j.kind = 'research'
         AND j.status IN ('pending', 'running', 'retry')`,
      [jobId],
    );
    return result.rows[0]?.topic ?? null;
  }

  async saveCandidate(
    jobId: string,
    candidate: SourceCandidate,
    document: SourceDocument,
  ): Promise<void> {
    if (
      !UUID.test(jobId) ||
      candidate.reviewStatus !== "candidate" ||
      document.sourceUrl !== candidate.sourceUrl
    ) {
      throw new Error("Research candidate rejected");
    }
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO vns.research_evidence
       (job_id, source_url, publisher, headline, claim_text, observed_at)
       SELECT rr.job_id, $2, $3, $4, $5, $6::timestamptz
       FROM vns.research_requests rr
       JOIN vns.jobs j ON j.id = rr.job_id
       WHERE rr.job_id = $1::uuid
         AND j.kind = 'research'
         AND j.status IN ('pending', 'running', 'retry')
       ON CONFLICT (job_id, source_url, claim_text) DO NOTHING
       RETURNING id::text AS id`,
      [
        jobId,
        candidate.sourceUrl,
        candidate.publisher,
        candidate.headline,
        candidate.claim,
        document.fetchedAt,
      ],
    );
    if (result.rows.length === 1) return;

    // Previous delivery may have inserted the same claim; preserve the
    // original provenance and reviewer status without ever overwriting it.
    const existing = await this.pool.query<{ publisher: string; headline: string }>(
      `SELECT publisher, headline FROM vns.research_evidence
       WHERE job_id = $1::uuid AND source_url = $2 AND claim_text = $3`,
      [jobId, candidate.sourceUrl, candidate.claim],
    );
    if (
      existing.rows.length !== 1 ||
      existing.rows[0]?.publisher !== candidate.publisher ||
      existing.rows[0]?.headline !== candidate.headline
    ) {
      throw new Error("Research evidence conflicts with existing provenance");
    }
  }
}
