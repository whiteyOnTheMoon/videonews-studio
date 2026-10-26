import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFeedArticles,
  groupExactHeadlineEvents,
  rankOfflineEvents,
  buildOfflineDraft,
  independentlyCheckDraft,
  exportOfflineEditorialReport,
  type EditorialProfile,
} from "./offline-editorial-pipeline.js";

const profile: EditorialProfile = {
  id: "world_news",
  language: "de-DE",
  keywords: ["science"],
  blockedTerms: ["sponsored"],
  minIndependentSources: 2,
  maximumArticleAgeHours: 72,
  format: "briefing",
};
const item = (sourceId: string, url: string, headline = "Science update worldwide") => ({
  sourceId, url, headline, publishedAt: "2026-10-26T12:00:00.000Z",
  reviewStatus: "candidate" as const,
});

test("offline metadata pipeline produces explainable unpublished report", () => {
  const articles = normalizeFeedArticles([
    item("news_one", "https://one.example.org/news/a"),
    item("news_two", "https://two.example.org/news/b"),
  ]);
  const groups = groupExactHeadlineEvents(articles);
  assert.equal(groups.length, 1);
  const ranked = rankOfflineEvents(groups, profile, new Date("2026-10-26T13:00:00.000Z"));
  assert.equal(ranked.length, 1);
  assert.match(ranked[0]!.reasons.join(" "), /independent_sources:2/);
  const draft = buildOfflineDraft(ranked[0]!, profile);
  assert.equal(draft.format, "briefing");
  assert.equal(draft.claims[0]!.status, "uncertain");
  assert.equal(independentlyCheckDraft(ranked[0]!, draft).accepted, false);
  const report = exportOfflineEditorialReport(ranked[0]!, profile, draft);
  assert.equal(report.approvedForPublication, false);
  assert.equal(report.sourceUrls.length, 2);
  assert.ok(report.decisions.includes("unverified_claim"));
});

test("blocked topics, insufficient sources and future articles never rank", () => {
  const articles = normalizeFeedArticles([item("news_one", "https://one.example.org/news/a")]);
  const event = groupExactHeadlineEvents(articles);
  assert.equal(rankOfflineEvents(event, profile, new Date("2026-10-26T13:00:00.000Z")).length, 0);
  assert.equal(rankOfflineEvents(event, { ...profile, minIndependentSources: 1 },
    new Date("2026-10-25T13:00:00.000Z")).length, 0);
  const sponsored = groupExactHeadlineEvents(
    normalizeFeedArticles([item("news_one", "https://one.example.org/news/b", "Sponsored science bulletin")]),
  );
  assert.equal(rankOfflineEvents(sponsored, { ...profile, minIndependentSources: 1 },
    new Date("2026-10-26T13:00:00.000Z")).length, 0);
});

test("noncanonical URLs and forged evidence IDs are rejected", () => {
  assert.throws(() => normalizeFeedArticles([
    item("news_one", "https://one.example.org/news/a?tracking=1"),
  ]));
  const article = normalizeFeedArticles([item("news_one", "https://one.example.org/news/a")]);
  const event = { ...groupExactHeadlineEvents(article)[0]!, score: 1 };
  const draft = buildOfflineDraft(event, { ...profile, minIndependentSources: 1 });
  assert.equal(independentlyCheckDraft(event, {
    ...draft, claims: [{ statement: "Invented statistic 42%", articleIds: ["forged"], status: "verified" }],
  }).accepted, false);
});
