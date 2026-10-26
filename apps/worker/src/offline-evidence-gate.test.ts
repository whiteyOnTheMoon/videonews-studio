import assert from "node:assert/strict";
import test from "node:test";
import { gateOfflineClaimEvidence } from "./offline-evidence-gate.js";
import type { EditorialDraft, NewsEvent } from "./offline-editorial-pipeline.js";

const at = "2026-10-26T12:00:00.000Z";
const article = {
  id: "article_1",
  sourceId: "news_one",
  url: "https://news.example.org/article",
  headline: "Scientific research initiative announced",
  publishedAt: at,
  titleFingerprint: "fingerprint",
};
const event: NewsEvent = {
  id: "event_1",
  headline: article.headline,
  articles: [article],
  score: 25,
  reasons: [],
};
const draft: EditorialDraft = {
  format: "briefing",
  language: "en-US",
  headline: article.headline,
  paragraphs: ["Unpublished, synthetic review example."],
  claims: [{ statement: article.headline, articleIds: [article.id], status: "verified" }],
};
const reviewed = [
  {
    statement: article.headline,
    reviewerId: "reviewer_01",
    reviewedAt: at,
    evidence: [{ articleId: article.id, sourceUrl: article.url, checkedAt: at }],
    decision: "supported" as const,
  },
];

test("even independent supported evidence never automatically authorizes publication", () => {
  assert.deepEqual(gateOfflineClaimEvidence(event, draft, reviewed, new Date(at), 24), {
    ready: false,
    reasons: [],
  });
});

test("forged review, mismatched URL and stale evidence are refused", () => {
  assert.ok(
    gateOfflineClaimEvidence(event, draft, [], new Date(at), 24).reasons.includes(
      "claim_not_independently_supported",
    ),
  );
  assert.ok(
    gateOfflineClaimEvidence(
      event,
      draft,
      [
        {
          ...reviewed[0]!,
          evidence: [{ ...reviewed[0]!.evidence[0]!, sourceUrl: "https://fake.example.org" }],
        },
      ],
      new Date(at),
      24,
    ).reasons.includes("evidence_mismatch"),
  );
  assert.ok(
    gateOfflineClaimEvidence(
      event,
      draft,
      reviewed,
      new Date("2026-10-29T12:00:00.000Z"),
      24,
    ).reasons.includes("review_expired"),
  );
  assert.ok(
    gateOfflineClaimEvidence(
      event,
      draft,
      [reviewed[0]!, reviewed[0]!],
      new Date(at),
      24,
    ).reasons.includes("duplicate_review"),
  );
});

test("invalid review clock or age policy aborts", () => {
  assert.throws(() => gateOfflineClaimEvidence(event, draft, reviewed, new Date("invalid"), 24));
  assert.throws(() => gateOfflineClaimEvidence(event, draft, reviewed, new Date(at), 0));
});
