import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFeedArticles,
  validateEditorialProfile,
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
  assert.ok(ranked[0]!.reasons.includes("distinct_source_ids:2"));
  assert.ok(ranked[0]!.reasons.includes("independent_verification_required"));
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

test("candidate grouping rejects forged identities and headline fingerprints", () => {
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
  ]);
  const [first, second] = articles;
  assert.ok(first && second);
  for (const tampered of [
    { ...second, titleFingerprint: first.titleFingerprint },
    { ...second, id: "f".repeat(64) },
    { ...second, sourceId: first.sourceId },
    { ...second, headline: first.headline },
    { ...second, publishedAt: "2026-10-26" },
  ]) {
    assert.throws(() => groupConservativeEventCandidates([first, tampered]));
  }
  assert.equal(groupConservativeEventCandidates(articles).length, 2);
});

test("self-labelled verified claims never pass the independent offline review gate", () => {
  const articles = normalizeFeedArticles([
    item("news_one", "https://one.example.org/news/a"),
    item("news_two", "https://two.example.org/news/b"),
  ]);
  const event = { ...groupExactHeadlineEvents(articles)[0]!, score: 1 };
  const draft = buildOfflineDraft(event, profile);
  const forged = {
    ...draft,
    claims: [
      {
        statement: "Unsupported fictional statistic",
        articleIds: [articles[0]!.id],
        status: "verified" as const,
      },
    ],
  };
  const review = independentlyCheckDraft(event, forged);
  assert.equal(review.accepted, false);
  assert.ok(review.reasons.includes("independent_review_not_attested"));
  const report = exportOfflineEditorialReport(event, profile, forged);
  assert.equal(report.approvedForPublication, false);
  assert.ok(report.decisions.includes("independent_review_not_attested"));
});

test("ranking validates source/hash integrity and refuses a forged display headline", () => {
  const articles = normalizeFeedArticles([
    item("news_one", "https://one.example.org/news/a"),
    item("news_two", "https://two.example.org/news/b"),
  ]);
  const event = groupExactHeadlineEvents(articles)[0]!;
  const at = new Date("2026-10-26T13:00:00.000Z");
  const forgeries = [
    { ...event, headline: "Unrelated science headline" },
    { ...event, articles: [{ ...articles[0]!, id: "f".repeat(64) }, articles[1]!] },
    { ...event, articles: [{ ...articles[0]!, titleFingerprint: "f".repeat(64) }, articles[1]!] },
    { ...event, articles: [{ ...articles[0]!, sourceId: "another_feed" }, articles[1]!] },
  ];
  for (const bad of forgeries) {
    assert.throws(() => rankOfflineEvents([bad], profile, at), /Ranking candidate/);
  }
  assert.throws(() => rankOfflineEvents([event, event], profile, at));
});

test("ranking uses full Unicode word boundaries for terms and blocklists", () => {
  const articles = normalizeFeedArticles([
    item("news_one", "https://one.example.org/news/award", "Science award for public research"),
    item("news_two", "https://two.example.org/news/award", "Science award for public research"),
  ]);
  const event = groupExactHeadlineEvents(articles);
  const now = new Date("2026-10-26T13:00:00.000Z");
  assert.equal(rankOfflineEvents(event, { ...profile, blockedTerms: ["war"] }, now).length, 1);
  assert.equal(
    rankOfflineEvents(event, { ...profile, blockedTerms: ["science award"] }, now).length,
    0,
  );
  const ranked = rankOfflineEvents(event, { ...profile, keywords: ["war", "science award"] }, now);
  assert.deepEqual(
    ranked[0]!.reasons.filter((reason) => reason.startsWith("keyword_matches:")),
    ["keyword_matches:1"],
  );
});

test("fresh headlines cannot revive a stale article within a metadata candidate", () => {
  const articles = normalizeFeedArticles([
    item("news_one", "https://one.example.org/news/a"),
    {
      ...item("news_two", "https://two.example.org/news/b"),
      publishedAt: "2026-10-01T12:00:00.000Z",
    },
  ]);
  const event = groupExactHeadlineEvents(articles);
  assert.equal(rankOfflineEvents(event, profile, new Date("2026-10-26T13:00:00.000Z")).length, 0);
});

test("ranking profiles reject duplicate or contradictory normalized terms", () => {
  assert.deepEqual(validateEditorialProfile(profile), profile);
  for (const invalid of [
    { ...profile, keywords: ["science", "SCIENCE"] },
    { ...profile, keywords: ["science news", "science-news"] },
    { ...profile, keywords: ["--"] },
    { ...profile, blockedTerms: ["Science"] },
    { ...profile, keywords: Array.from({ length: 31 }, (_, i) => "topic" + i) },
  ]) {
    assert.throws(() => validateEditorialProfile(invalid));
    assert.throws(() => rankOfflineEvents([], invalid, new Date("2026-10-26T13:00:00.000Z")));
  }
});
