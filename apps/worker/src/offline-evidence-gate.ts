import type { EditorialDraft, NewsEvent } from "./offline-editorial-pipeline.js";

export interface IndependentClaimReview {
  readonly statement: string;
  readonly reviewerId: string;
  readonly reviewedAt: string;
  readonly evidence: readonly {
    articleId: string;
    sourceUrl: string;
    checkedAt: string;
  }[];
  readonly decision: "supported" | "rejected" | "uncertain";
}

/**
 * Metadata-only timestamp contract. Normalization at the ingestion boundary
 * emits exact UTC milliseconds; tolerate neither date normalization nor a
 * loosely parsed local timezone on subsequent editorial review.
 */
function canonicalReviewInstant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value ? millis : null;
}

/**
 * Offline contract validation, NOT identity authentication or fact verification.
 * A plain JSON reviewerId must never be mistaken for an authenticated human.
 * Publishing remains unconditionally disabled until independent verified
 * approvals are implemented and operationally accepted.
 */
export function gateOfflineClaimEvidence(
  event: NewsEvent,
  draft: EditorialDraft,
  reviews: readonly IndependentClaimReview[],
  now: Date,
  maxAgeHours: number,
): { ready: false; reasons: readonly string[] } {
  const reasons: string[] = [];
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Editorial review clock invalid");
  }
  if (!Number.isSafeInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 720) {
    throw new Error("Editorial review age threshold invalid");
  }
  const maxAgeMillis = maxAgeHours * 3600000;
  const articles = new Map(event.articles.map((article) => [article.id, article]));
  const statementIds = new Set<string>();
  for (const claim of draft.claims) {
    if (statementIds.has(claim.statement)) reasons.push("duplicate_claim");
    statementIds.add(claim.statement);
  }
  const reviewMap = new Map<string, IndependentClaimReview>();
  for (const review of reviews) {
    if (!statementIds.has(review.statement)) reasons.push("unrelated_review");
    if (reviewMap.has(review.statement)) reasons.push("duplicate_review");
    reviewMap.set(review.statement, review);
  }
  if (!draft.claims.length) reasons.push("no_claims");
  for (const claim of draft.claims) {
    if (claim.status !== "verified") reasons.push("claim_not_verified");
    if (!claim.statement.trim()) reasons.push("empty_claim");
    const review = reviewMap.get(claim.statement);
    if (!review || review.decision !== "supported") {
      reasons.push("claim_not_independently_supported");
      continue;
    }
    if (!/^[a-z][a-z0-9_-]{2,40}$/.test(review.reviewerId)) {
      reasons.push("reviewer_identity_invalid");
    }
    const reviewedAt = canonicalReviewInstant(review.reviewedAt);
    if (
      reviewedAt === null ||
      reviewedAt > now.getTime() ||
      reviewedAt < now.getTime() - maxAgeMillis
    ) {
      reasons.push("review_expired");
    }
    if (!claim.articleIds.length || !Array.isArray(review.evidence) || !review.evidence.length) {
      reasons.push("missing_evidence");
      continue;
    }
    const evidenceIds = new Set<string>();
    for (const proof of review.evidence) {
      if (evidenceIds.has(proof.articleId)) reasons.push("duplicate_evidence");
      evidenceIds.add(proof.articleId);
      if (!claim.articleIds.includes(proof.articleId)) reasons.push("unrelated_evidence");
    }
    for (const id of claim.articleIds) {
      const article = articles.get(id);
      const support = review.evidence.find((proof) => proof.articleId === id);
      if (!article || !support || article.url !== support.sourceUrl) {
        reasons.push("evidence_mismatch");
        continue;
      }
      const publishedAt = canonicalReviewInstant(article.publishedAt);
      if (
        publishedAt === null ||
        publishedAt > now.getTime() ||
        publishedAt < now.getTime() - maxAgeMillis
      ) {
        reasons.push("article_outdated");
      }
      const checkedAt = canonicalReviewInstant(support.checkedAt);
      if (
        checkedAt === null ||
        checkedAt > now.getTime() ||
        checkedAt < now.getTime() - maxAgeMillis
      ) {
        reasons.push("evidence_expired");
      }
      if (
        checkedAt !== null &&
        ((publishedAt !== null && checkedAt < publishedAt) ||
          (reviewedAt !== null && checkedAt > reviewedAt))
      ) {
        reasons.push("evidence_timeline_conflict");
      }
    }
  }
  // This helper never grants publication, even with no detected defects.
  return { ready: false, reasons: [...new Set(reasons)] };
}
