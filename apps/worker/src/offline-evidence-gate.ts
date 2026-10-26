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

/** No automated claim certification: verified evidence must originate from a separate review. */
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
  const articles = new Map(event.articles.map((article) => [article.id, article]));
  const reviewMap = new Map<string, IndependentClaimReview>();
  for (const review of reviews) {
    if (reviewMap.has(review.statement)) {
      reasons.push("duplicate_review");
    }
    reviewMap.set(review.statement, review);
  }
  if (!draft.claims.length) reasons.push("no_claims");
  for (const claim of draft.claims) {
    const review = reviewMap.get(claim.statement);
    if (!review || review.decision !== "supported") {
      reasons.push("claim_not_independently_supported");
      continue;
    }
    if (!/^[a-z][a-z0-9_-]{2,40}$/.test(review.reviewerId)) {
      reasons.push("reviewer_identity_invalid");
    }
    const reviewedAt = Date.parse(review.reviewedAt);
    if (
      !Number.isFinite(reviewedAt) ||
      reviewedAt > now.getTime() ||
      reviewedAt < now.getTime() - maxAgeHours * 3600000
    ) {
      reasons.push("review_expired");
    }
    if (!claim.articleIds.length || !review.evidence.length) {
      reasons.push("missing_evidence");
    }
    for (const id of claim.articleIds) {
      const article = articles.get(id);
      const support = review.evidence.find((proof) => proof.articleId === id);
      if (!article || !support || article.url !== support.sourceUrl) {
        reasons.push("evidence_mismatch");
        continue;
      }
      const checkedAt = Date.parse(support.checkedAt);
      if (
        !Number.isFinite(checkedAt) ||
        checkedAt > now.getTime() ||
        checkedAt < now.getTime() - maxAgeHours * 3600000
      ) {
        reasons.push("evidence_expired");
      }
    }
  }
  // Never permits publication; this is one required check among many.
  return { ready: false, reasons: [...new Set(reasons)] };
}
