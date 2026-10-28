import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { DormantEditorialCheckpointStore } from "./dormant-editorial-checkpoint-store.js";
import {
  prepareOfflineClaimCheckpoint,
  recordOfflineClaimCheckpoint,
} from "./offline-claim-checkpoint-handoff.js";
import type { IndependentClaimReview } from "./offline-evidence-gate.js";
import {
  groupExactHeadlineEvents,
  normalizeFeedArticles,
  type EditorialDraft,
} from "./offline-editorial-pipeline.js";

const dbEventId = "ca300003-3333-4333-8333-333333333333";
const published = "2026-10-26T12:00:00.000Z";
const observed = "2026-10-26T12:30:00.000Z";
const now = new Date("2026-10-26T13:00:00.000Z");
const articles = normalizeFeedArticles([
  {
    sourceId: "news_one",
    url: "https://one.example.org/story",
    headline: "Scientific study confirms a new discovery today",
    publishedAt: published,
    reviewStatus: "candidate",
  },
  {
    sourceId: "news_two",
    url: "https://two.example.org/story",
    headline: "Scientific study confirms a new discovery today",
    publishedAt: published,
    reviewStatus: "candidate",
  },
]);
const event = groupExactHeadlineEvents(articles)[0]!;
const draft: EditorialDraft = {
  format: "briefing",
  language: "de-DE",
  headline: event.headline,
  paragraphs: ["Internal synthetic claim review; no publication authorized."],
  claims: [
    {
      statement: "A synthetic discovery claim requiring a human reviewer",
      articleIds: articles.map((article) => article.id),
      status: "verified",
    },
  ],
};
const reviews: IndependentClaimReview[] = [
  {
    statement: draft.claims[0]!.statement,
    reviewerId: "human_reviewer_01",
    reviewedAt: now.toISOString(),
    decision: "supported",
    evidence: articles.map((article) => ({
      articleId: article.id,
      sourceUrl: article.url,
      checkedAt: observed,
    })),
  },
];

test("supported metadata becomes needs_review, never a publishing approval", () => {
  const output = prepareOfflineClaimCheckpoint(dbEventId, event, draft, reviews, now, 24);
  assert.equal(output.stage, "claim_review");
  assert.equal(output.outcome, "needs_review");
  assert.equal(output.approvedForPublication, false);
  assert.equal(output.score, null);
  assert.deepEqual(output.reasonCodes, ["independent_reviewer_auth_required"]);
  assert.match(output.artifactSha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.reasonCodes));
  assert.equal(JSON.stringify(output).includes("https://one.example.org"), false);
  assert.equal(JSON.stringify(output).includes(draft.claims[0]!.statement), false);
});

test("claim evidence metadata is digested consistently regardless of input ordering", () => {
  const initial = prepareOfflineClaimCheckpoint(dbEventId, event, draft, reviews, now, 24);
  const reordered = prepareOfflineClaimCheckpoint(
    dbEventId,
    { ...event, articles: [...event.articles].reverse() },
    {
      ...draft,
      claims: [{ ...draft.claims[0]!, articleIds: [...draft.claims[0]!.articleIds].reverse() }],
    },
    [{ ...reviews[0]!, evidence: [...reviews[0]!.evidence].reverse() }],
    now,
    24,
  );
  assert.deepEqual(initial, reordered);
  const changed = prepareOfflineClaimCheckpoint(
    dbEventId,
    event,
    { ...draft, paragraphs: ["A revised synthetic script changes the evidence digest."] },
    reviews,
    now,
    24,
  );
  assert.notEqual(initial.artifactSha256, changed.artifactSha256);
  assert.notEqual(
    initial.artifactSha256,
    prepareOfflineClaimCheckpoint(
      "ca300004-4444-4444-8444-444444444444",
      event,
      draft,
      reviews,
      now,
      24,
    ).artifactSha256,
  );
});

test("unverified, missing or inconsistent evidence can produce only blocked checkpoints", () => {
  const variants = [
    {
      draft: { ...draft, claims: [{ ...draft.claims[0]!, status: "uncertain" as const }] },
      reviews,
    },
    { draft, reviews: [] },
    {
      draft,
      reviews: [
        {
          ...reviews[0]!,
          evidence: [
            { ...reviews[0]!.evidence[0]!, sourceUrl: "https://forged.example.org/story" },
            reviews[0]!.evidence[1]!,
          ],
        },
      ],
    },
  ];
  for (const variant of variants) {
    const output = prepareOfflineClaimCheckpoint(
      dbEventId,
      event,
      variant.draft,
      variant.reviews,
      now,
      24,
    );
    assert.equal(output.outcome, "blocked");
    assert.equal(output.approvedForPublication, false);
    assert.ok(output.reasonCodes.includes("independent_reviewer_auth_required"));
  }
});

test("named DB handoff binds digest-only fields, conflict stays a conflict", async () => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    async query(sql: string, args: unknown[]) {
      calls.push({ sql, args });
      return { rows: [{ saved: calls.length === 1 }] };
    },
  } as unknown as Pool;
  const enabled = {
    VNS_EDITORIAL_CHECKPOINT_OFFLINE_ENABLED: "true",
    VNS_EDITORIAL_CHECKPOINT_OPERATOR_ACK: "true",
  };
  const store = new DormantEditorialCheckpointStore(pool, enabled);
  const first = await recordOfflineClaimCheckpoint(
    store,
    dbEventId,
    0,
    event,
    draft,
    reviews,
    now,
    24,
  );
  assert.deepEqual(
    { saved: first.saved, conflict: first.conflict },
    { saved: true, conflict: false },
  );
  const second = await recordOfflineClaimCheckpoint(
    store,
    dbEventId,
    0,
    event,
    draft,
    reviews,
    now,
    24,
  );
  assert.deepEqual(
    { saved: second.saved, conflict: second.conflict },
    { saved: false, conflict: true },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.args, [
    dbEventId,
    0,
    "claim_review",
    "needs_review",
    first.checkpoint.artifactSha256,
    JSON.stringify(first.checkpoint.reasonCodes),
    null,
  ]);
  assert.equal(JSON.stringify(calls).includes("https://one.example.org"), false);
  assert.equal(JSON.stringify(calls).includes(draft.claims[0]!.statement), false);
});

test("invalid input or disabled human DB session never writes a checkpoint", async () => {
  let queries = 0;
  const pool = {
    async query() {
      queries++;
      return { rows: [{ saved: true }] };
    },
  } as unknown as Pool;
  assert.throws(() => new DormantEditorialCheckpointStore(pool, {}), /disabled/);
  const store = new DormantEditorialCheckpointStore(pool, {
    VNS_EDITORIAL_CHECKPOINT_OFFLINE_ENABLED: "true",
    VNS_EDITORIAL_CHECKPOINT_OPERATOR_ACK: "true",
  });
  for (const [badEventId, badEvent] of [
    ["not-a-uuid", event],
    [dbEventId, { ...event, articles: [{ ...articles[0]!, id: "f".repeat(64) }, articles[1]!] }],
  ] as const) {
    await assert.rejects(
      recordOfflineClaimCheckpoint(store, badEventId, 0, badEvent, draft, reviews, now, 24),
    );
  }
  await assert.rejects(
    recordOfflineClaimCheckpoint(store, dbEventId, -1, event, draft, reviews, now, 24),
  );
  assert.equal(queries, 0);
});
