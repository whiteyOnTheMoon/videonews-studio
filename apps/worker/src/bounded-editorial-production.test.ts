import assert from "node:assert/strict";
import test from "node:test";
import {
  assessEditorialCandidate,
  generateBoundedMockScript,
  independentlyReviewMockScript,
  type ClaimCandidate,
  type SourceProvenance,
  type ScriptLimits,
  type ScriptScaffold,
  type WeightedRankingPolicy,
} from "./bounded-editorial-production.js";
import {
  normalizeFeedArticles,
  type EditorialProfile,
  type NewsEvent,
} from "./offline-editorial-pipeline.js";

const now = new Date("2026-10-26T13:00:00.000Z");
const profile: EditorialProfile = {
  id: "science_news",
  language: "de-DE",
  keywords: ["science"],
  blockedTerms: ["misinformation"],
  minIndependentSources: 2,
  maximumArticleAgeHours: 24,
  format: "briefing",
};
const articles = normalizeFeedArticles([
  {
    sourceId: "source_alpha",
    url: "https://alpha.example.org/story",
    headline: "Important science study was released today",
    publishedAt: "2026-10-26T11:00:00.000Z",
    reviewStatus: "candidate",
  },
  {
    sourceId: "source_beta",
    url: "https://beta.example.org/story",
    headline: "Important science study was released today",
    publishedAt: "2026-10-26T11:00:00.000Z",
    reviewStatus: "candidate",
  },
]);
const event: NewsEvent = {
  id: "a".repeat(64),
  headline: "Important science study was released today",
  articles,
  score: 0,
  reasons: [],
};
const policy: WeightedRankingPolicy = {
  maxAgeHours: 24,
  minimumPublisherGroups: 2,
  relevanceWeight: 10,
  freshnessWeight: 20,
  qualityWeight: 15,
  explanatoryWeight: 5,
  blockedTerms: ["inappropriate rumor"],
};
const provenance: SourceProvenance[] = [
  { sourceId: "source_alpha", publisherGroup: "group_alpha", rightsApproved: true, quality: 4 },
  { sourceId: "source_beta", publisherGroup: "group_beta", rightsApproved: true, quality: 5 },
];
const claims: ClaimCandidate[] = [
  {
    id: "claim_one",
    statement: "An unverified claim requiring independent review",
    articleIds: articles.map((article) => article.id),
    status: "unverified",
  },
];
const scaffold: ScriptScaffold = {
  briefing: "Redaktionelle Kurzmeldung: Fakten müssen überprüft werden.",
  analysis: "Redaktionelle Einordnung: Kontext muss separat überprüft werden.",
  explainer: "Redaktionelles Erklärstück: Begriffe müssen überprüft werden.",
};
const limits: ScriptLimits = {
  maxCharacters: 1000,
  maxMockTokens: 500,
  maxMicroUsd: 500,
  mockMicroUsdPerToken: 1,
  maxRevisions: 2,
};

test("rank with explicit publisher provenance and deterministic weighted reasons", () => {
  const ranked = assessEditorialCandidate(event, profile, policy, provenance, now);
  const reversed = assessEditorialCandidate(event, profile, policy, [...provenance].reverse(), now);
  assert.deepEqual(ranked, reversed);
  assert.equal(ranked.eligible, true);
  assert.ok(ranked.score > 0);
  assert.equal(ranked.publisherGroups, 2);
  assert.ok(ranked.reasons.includes("independent_confirmation_not_established"));
});

test("syndication, missing rights, missing source and stale metadata block ranking", () => {
  const syndicated = provenance.map((entry) => ({ ...entry, publisherGroup: "same_group" }));
  assert.ok(
    assessEditorialCandidate(event, profile, policy, syndicated, now).reasons.includes(
      "publisher_groups_insufficient",
    ),
  );
  const unlicensed = [{ ...provenance[0]!, rightsApproved: false }, provenance[1]!];
  assert.ok(
    assessEditorialCandidate(event, profile, policy, unlicensed, now).reasons.includes(
      "source_rights_missing",
    ),
  );
  assert.ok(
    assessEditorialCandidate(event, profile, policy, [provenance[0]!], now).reasons.includes(
      "source_provenance_missing",
    ),
  );
  const stale = {
    ...event,
    articles: event.articles.map((article) => ({
      ...article,
      publishedAt: "2026-10-21T11:00:00.000Z",
    })),
  };
  assert.ok(
    assessEditorialCandidate(stale, profile, policy, provenance, now).reasons.includes(
      "stale_or_future_article",
    ),
  );
  assert.throws(() =>
    assessEditorialCandidate(event, profile, { ...policy, relevanceWeight: -1 }, provenance, now),
  );
});

test("all three configured formats stay offline with explicit revision and limits", () => {
  for (const format of ["briefing", "analysis", "explainer"] as const) {
    const script = generateBoundedMockScript(
      event,
      { ...profile, format },
      claims,
      scaffold,
      limits,
      1,
    );
    assert.equal(script.provider, "offline_mock");
    assert.equal(script.approvedForPublication, false);
    assert.equal(script.language, "de-DE");
    assert.equal(script.format, format);
    assert.deepEqual(script.sections[0]!.claimIds, ["claim_one"]);
    assert.ok(script.estimatedMicroUsd <= limits.maxMicroUsd);
  }
  assert.throws(() => generateBoundedMockScript(event, profile, claims, scaffold, limits, 3));
  assert.throws(() =>
    generateBoundedMockScript(event, profile, claims, scaffold, { ...limits, maxMockTokens: 2 }, 1),
  );
});

test("independent structural QA never certifies factual or legal clearance", () => {
  const script = generateBoundedMockScript(event, profile, claims, scaffold, limits, 1);
  const report = independentlyReviewMockScript(event, script, claims, policy, provenance, now);
  assert.equal(report.acceptedForHumanReview, true);
  assert.equal(report.approvedForPublication, false);
  assert.equal(report.digest.length, 64);
  assert.ok(report.reasons.includes("independent_claim_verification_required"));
  assert.deepEqual(
    report,
    independentlyReviewMockScript(event, script, claims, policy, provenance, now),
  );
});

test("QA catches missing references, changed evidence and verbatim headline text", () => {
  const script = generateBoundedMockScript(event, profile, claims, scaffold, limits, 1);
  const forged = {
    ...script,
    sections: [
      {
        narration: event.headline,
        claimIds: ["unknown_claim"],
      },
    ],
  };
  const report = independentlyReviewMockScript(event, forged, claims, policy, provenance, now);
  assert.equal(report.acceptedForHumanReview, false);
  assert.ok(report.reasons.includes("unknown_claim_reference"));
  assert.ok(report.reasons.includes("source_text_similarity_risk"));
  assert.ok(report.reasons.includes("unrepresented_claim"));
  const disputed = [{ ...claims[0]!, status: "disputed" as const }];
  const blocked = independentlyReviewMockScript(event, script, disputed, policy, provenance, now);
  assert.equal(blocked.acceptedForHumanReview, false);
  assert.ok(blocked.reasons.includes("claim_disputed_or_rejected"));
});
