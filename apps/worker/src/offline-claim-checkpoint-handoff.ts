import { createHash } from "node:crypto";
import type { DormantEditorialCheckpointStore } from "./dormant-editorial-checkpoint-store.js";
import {
  attestEditorialEventMetadata,
  type EditorialDraft,
  type NewsEvent,
} from "./offline-editorial-pipeline.js";
import {
  gateOfflineClaimEvidence,
  type IndependentClaimReview,
} from "./offline-evidence-gate.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REASON = /^[a-z][a-z0-9_]{1,39}$/;
const AUTH_REASON = "independent_reviewer_auth_required";

export interface PreparedOfflineClaimCheckpoint {
  readonly stage: "claim_review";
  readonly outcome: "blocked" | "needs_review";
  readonly artifactSha256: string;
  readonly reasonCodes: readonly string[];
  readonly score: null;
  readonly approvedForPublication: false;
}

/**
 * Evidence metadata is not an authenticated human review. Produce an
 * immutable, digest-only checkpoint proposal, never a publication decision.
 * The distinct DB event UUID must already be associated with the news event
 * by the personally authorized caller; this helper cannot prove that mapping.
 */
export function prepareOfflineClaimCheckpoint(
  dbEventId: string,
  event: NewsEvent,
  draft: EditorialDraft,
  reviews: readonly IndependentClaimReview[],
  now: Date,
  maxAgeHours: number,
): PreparedOfflineClaimCheckpoint {
  if (
    typeof dbEventId !== "string" ||
    !UUID.test(dbEventId) ||
    !event ||
    typeof event.id !== "string" ||
    !SHA256.test(event.id) ||
    !draft ||
    !Array.isArray(draft.claims) ||
    draft.claims.length < 1 ||
    draft.claims.length > 30 ||
    !Array.isArray(draft.paragraphs) ||
    draft.paragraphs.length > 30 ||
    !Array.isArray(reviews) ||
    reviews.length > 30 ||
    reviews.some(
      (review) =>
        !review ||
        !Array.isArray(review.evidence) ||
        review.evidence.length > 20,
    )
  ) {
    throw new Error("Offline claim checkpoint input invalid");
  }
  attestEditorialEventMetadata(event);
  const result = gateOfflineClaimEvidence(event, draft, reviews, now, maxAgeHours);
  const reasonCodes = [...new Set([...result.reasons, AUTH_REASON])].sort();
  if (
    reasonCodes.length > 20 ||
    reasonCodes.some((reason) => !REASON.test(reason))
  ) {
    throw new Error("Offline claim checkpoint reasons invalid");
  }

  // Canonical ordering removes irrelevant article/reviewer input ordering.
  // Complete draft text and evidence references affect the digest, but are
  // never inserted into the digest-only PostgreSQL checkpoint table.
  const snapshot = {
    schemaVersion: 1,
    dbEventId,
    eventId: event.id,
    observedAt: now.toISOString(),
    maxAgeHours,
    articles: event.articles
      .map((article) => ({
        id: article.id,
        sourceId: article.sourceId,
        url: article.url,
        headline: article.headline,
        titleFingerprint: article.titleFingerprint,
        publishedAt: article.publishedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    draft: {
      format: draft.format,
      language: draft.language,
      headline: draft.headline,
      paragraphs: draft.paragraphs,
      claims: [...draft.claims]
        .map((claim) => ({
          statement: claim.statement,
          status: claim.status,
          articleIds: [...claim.articleIds].sort(),
        }))
        .sort((a, b) => a.statement.localeCompare(b.statement)),
    },
    reviews: reviews
      .map((review) => ({
        statement: review.statement,
        reviewerId: review.reviewerId,
        reviewedAt: review.reviewedAt,
        decision: review.decision,
        evidence: review.evidence
          .map((proof: IndependentClaimReview["evidence"][number]) => ({
            articleId: proof.articleId,
            sourceUrl: proof.sourceUrl,
            checkedAt: proof.checkedAt,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    reasonCodes,
  };
  const encoded = JSON.stringify(snapshot);
  if (encoded.length > 200000) {
    throw new Error("Offline claim checkpoint snapshot exceeded");
  }
  const digest = createHash("sha256").update(encoded).digest("hex");
  return Object.freeze({
    stage: "claim_review",
    outcome: result.reasons.length ? "blocked" : "needs_review",
    artifactSha256: digest,
    reasonCodes: Object.freeze(reasonCodes),
    score: null,
    approvedForPublication: false,
  });
}

/**
 * Explicit named-human DB handoff; never run automatically in a feed worker.
 * The injected store is subject to its own default-off flags, and SQL binds
 * the true session_user / reviewer role and performs revision CAS.
 */
export async function recordOfflineClaimCheckpoint(
  store: Pick<DormantEditorialCheckpointStore, "append">,
  dbEventId: string,
  expectedRevision: number,
  event: NewsEvent,
  draft: EditorialDraft,
  reviews: readonly IndependentClaimReview[],
  now: Date,
  maxAgeHours: number,
): Promise<{ saved: boolean; conflict: boolean; checkpoint: PreparedOfflineClaimCheckpoint }> {
  if (
    !store ||
    typeof store.append !== "function" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision > 9999
  ) {
    throw new Error("Named claim checkpoint handoff invalid");
  }
  const checkpoint = prepareOfflineClaimCheckpoint(
    dbEventId,
    event,
    draft,
    reviews,
    now,
    maxAgeHours,
  );
  const status = await store.append(
    dbEventId,
    expectedRevision,
    checkpoint.stage,
    checkpoint.outcome,
    checkpoint.artifactSha256,
    checkpoint.reasonCodes,
    checkpoint.score,
  );
  if (status !== "saved" && status !== "conflict") {
    throw new Error("Named claim checkpoint response invalid");
  }
  return { saved: status === "saved", conflict: status === "conflict", checkpoint };
}
