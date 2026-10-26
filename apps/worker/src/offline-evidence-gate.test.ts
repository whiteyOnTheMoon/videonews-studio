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

test("unverified and repeated claims cannot be treated as accepted evidence", () => {
  const altered: EditorialDraft = {
    ...draft,
    claims: [{ ...draft.claims[0]!, status: "uncertain" }, draft.claims[0]!],
  };
  const result = gateOfflineClaimEvidence(event, altered, reviewed, new Date(at), 24);
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("claim_not_verified"));
  assert.ok(result.reasons.includes("duplicate_claim"));
});

test("orphan reviews and unrelated or repeated evidence are explicit defects", () => {
  const result = gateOfflineClaimEvidence(
    event,
    draft,
    [
      {
        ...reviewed[0]!,
        evidence: [
          reviewed[0]!.evidence[0]!,
          reviewed[0]!.evidence[0]!,
          { articleId: "foreign", sourceUrl: article.url, checkedAt: at },
        ],
      },
      { ...reviewed[0]!, statement: "Unrelated reviewed claim" },
    ],
    new Date(at),
    24,
  );
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("duplicate_evidence"));
  assert.ok(result.reasons.includes("unrelated_evidence"));
  assert.ok(result.reasons.includes("unrelated_review"));
});

test("an old article fails even if the evidence was checked recently", () => {
  const oldEvent: NewsEvent = {
    ...event,
    articles: [{ ...article, publishedAt: "2026-10-20T12:00:00.000Z" }],
  };
  const result = gateOfflineClaimEvidence(oldEvent, draft, reviewed, new Date(at), 24);
  assert.ok(result.reasons.includes("article_outdated"));
});

test("review, observation and article timestamps must be canonical and chronological", () => {
  const invalidReview = [{ ...reviewed[0]!, reviewedAt: "2026-02-30T12:00:00.000Z" }];
  assert.ok(
    gateOfflineClaimEvidence(event, draft, invalidReview, new Date(at), 24).reasons.includes(
      "review_expired",
    ),
  );
  const futureObservation = [
    {
      ...reviewed[0]!,
      evidence: [{ ...reviewed[0]!.evidence[0]!, checkedAt: "2026-10-26T12:01:00.000Z" }],
    },
  ];
  assert.ok(
    gateOfflineClaimEvidence(
      event,
      draft,
      futureObservation,
      new Date("2026-10-26T13:00:00.000Z"),
      24,
    ).reasons.includes("evidence_timeline_conflict"),
  );
  const beforePublication = [
    {
      ...reviewed[0]!,
      evidence: [{ ...reviewed[0]!.evidence[0]!, checkedAt: "2026-10-26T11:00:00.000Z" }],
    },
  ];
  assert.ok(
    gateOfflineClaimEvidence(event, draft, beforePublication, new Date(at), 24).reasons.includes(
      "evidence_timeline_conflict",
    ),
  );
});
