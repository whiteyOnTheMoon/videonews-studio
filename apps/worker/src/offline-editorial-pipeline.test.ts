import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFeedArticles,
  groupExactHeadlineEvents,
  groupConservativeEventCandidates,
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
  sourceId,
  url,
  headline,
  publishedAt: "2026-10-26T12:00:00.000Z",
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
  assert.equal(
    rankOfflineEvents(
      event,
      { ...profile, minIndependentSources: 1 },
      new Date("2026-10-25T13:00:00.000Z"),
    ).length,
    0,
  );
  const sponsored = groupExactHeadlineEvents(
    normalizeFeedArticles([
      item("news_one", "https://one.example.org/news/b", "Sponsored science bulletin"),
    ]),
  );
  assert.equal(
    rankOfflineEvents(
      sponsored,
      { ...profile, minIndependentSources: 1 },
      new Date("2026-10-26T13:00:00.000Z"),
    ).length,
    0,
  );
});

test("noncanonical URLs and forged evidence IDs are rejected", () => {
  assert.throws(() =>
    normalizeFeedArticles([item("news_one", "https://one.example.org/news/a?tracking=1")]),
  );
  const article = normalizeFeedArticles([item("news_one", "https://one.example.org/news/a")]);
  const event = { ...groupExactHeadlineEvents(article)[0]!, score: 1 };
  const draft = buildOfflineDraft(event, { ...profile, minIndependentSources: 1 });
  assert.equal(
    independentlyCheckDraft(event, {
      ...draft,
      claims: [{ statement: "Invented statistic 42%", articleIds: ["forged"], status: "verified" }],
    }).accepted,
    false,
  );
});

test("rewritten syndicated headline is a single candidate, never verified", () => {
  const articles = normalizeFeedArticles([
    item(
      "news_one",
      "https://one.example.org/news/bridge",
      "City council approves new river bridge project today",
    ),
    item(
      "news_two",
      "https://two.example.org/news/bridge",
      "Today city council approves new river bridge project",
    ),
  ]);
  const events = groupConservativeEventCandidates(articles);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.articles.length, 2);
  assert.ok(events[0]!.reasons.includes("independent_verification_required"));
  const ranked = rankOfflineEvents(events, profile, new Date("2026-10-26T13:00:00.000Z"));
  assert.equal(ranked.length, 1);
  const draft = buildOfflineDraft(ranked[0]!, profile);
  assert.equal(independentlyCheckDraft(ranked[0]!, draft).accepted, false);
  assert.equal(
    exportOfflineEditorialReport(ranked[0]!, profile, draft).approvedForPublication,
    false,
  );
});

test("distinct and time-separated stories remain separate, independent of input order", () => {
  const articles = normalizeFeedArticles([
    item(
      "news_one",
      "https://one.example.org/news/bridge",
      "City council approves new river bridge project today",
    ),
    item(
      "news_two",
      "https://two.example.org/news/road",
      "City council approves new highway road project today",
    ),
    item(
      "news_three",
      "https://three.example.org/news/bridge",
      "Today city council approves new river bridge project",
    ),
  ]);
  const forward = groupConservativeEventCandidates(articles);
  const reverse = groupConservativeEventCandidates([...articles].reverse());
  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 2);
  const stale = articles.map((article, index) =>
    index === 2 ? { ...article, publishedAt: "2026-10-20T12:00:00.000Z" } : article,
  );
  assert.equal(groupConservativeEventCandidates(stale).length, 3);
  assert.throws(() => groupConservativeEventCandidates([articles[0]!, articles[0]!]));
  const repeated = normalizeFeedArticles([
    item("news_one", "https://one.example.org/news/other", "Science update worldwide"),
    item("news_two", "https://two.example.org/news/other", "Science update worldwide"),
  ]);
  const historic = { ...repeated[1]!, publishedAt: "2026-10-01T12:00:00.000Z" };
  assert.equal(groupConservativeEventCandidates([repeated[0]!, historic]).length, 2);
});
