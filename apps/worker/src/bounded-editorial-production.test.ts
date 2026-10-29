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
  const report = independentlyReviewMockScript(
    event,
    script,
    claims,
    policy,
    provenance,
    now,
    limits,
  );
  assert.equal(report.acceptedForHumanReview, true);
  assert.equal(report.approvedForPublication, false);
  assert.equal(report.digest.length, 64);
  assert.ok(report.reasons.includes("independent_claim_verification_required"));
  assert.deepEqual(
    report,
    independentlyReviewMockScript(event, script, claims, policy, provenance, now, limits),
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
  const report = independentlyReviewMockScript(
    event,
    forged,
    claims,
    policy,
    provenance,
    now,
    limits,
  );
  assert.equal(report.acceptedForHumanReview, false);
  assert.ok(report.reasons.includes("unknown_claim_reference"));
  assert.ok(report.reasons.includes("source_text_similarity_risk"));
  assert.ok(report.reasons.includes("unrepresented_claim"));
  const disputed = [{ ...claims[0]!, status: "disputed" as const }];
  const blocked = independentlyReviewMockScript(
    event,
    script,
    disputed,
    policy,
    provenance,
    now,
    limits,
  );
  assert.equal(blocked.acceptedForHumanReview, false);
  assert.ok(blocked.reasons.includes("claim_disputed_or_rejected"));
});

test("independent QA denies unknown or syndicated provenance rather than inferring confirmation", () => {
  const script = generateBoundedMockScript(event, profile, claims, scaffold, limits, 1);
  const missing = independentlyReviewMockScript(event, script, claims, policy, [], now, limits);
  assert.equal(missing.acceptedForHumanReview, false);
  assert.ok(missing.reasons.includes("source_provenance_missing"));
  assert.ok(missing.reasons.includes("source_rights_missing"));
  const syndicated = provenance.map((source) => ({ ...source, publisherGroup: "single_group" }));
  const result = independentlyReviewMockScript(
    event,
    script,
    claims,
    policy,
    syndicated,
    now,
    limits,
  );
  assert.equal(result.acceptedForHumanReview, false);
  assert.ok(result.reasons.includes("publisher_groups_insufficient"));
});

test("independent QA rejects forged token and cost figures using trusted limits", () => {
  const script = generateBoundedMockScript(event, profile, claims, scaffold, limits, 1);
  for (const tampered of [
    { ...script, estimatedMockTokens: 1 },
    { ...script, estimatedMicroUsd: 0 },
    { ...script, estimatedMockTokens: Number.NaN },
    { ...script, estimatedMicroUsd: Number.POSITIVE_INFINITY },
  ]) {
    const report = independentlyReviewMockScript(
      event,
      tampered,
      claims,
      policy,
      provenance,
      now,
      limits,
    );
    assert.equal(report.acceptedForHumanReview, false);
    assert.ok(report.reasons.includes("script_cost_integrity_mismatch"));
    assert.equal(report.approvedForPublication, false);
  }
});

test("independent QA rejects modified narration, breached limits and forged revision", () => {
  const script = generateBoundedMockScript(event, profile, claims, scaffold, limits, 1);
  const longer = {
    ...script,
    sections: [{ ...script.sections[0]!, narration: "Original additional text ".repeat(50) }],
  };
  const oversized = independentlyReviewMockScript(
    event,
    longer,
    claims,
    policy,
    provenance,
    now,
    limits,
  );
  assert.equal(oversized.acceptedForHumanReview, false);
  assert.ok(oversized.reasons.includes("script_budget_exceeded"));
  assert.ok(oversized.reasons.includes("script_cost_integrity_mismatch"));

  const forgedRevision = independentlyReviewMockScript(
    event,
    { ...script, revision: 3 },
    claims,
    policy,
    provenance,
    now,
    limits,
  );
  assert.ok(forgedRevision.reasons.includes("script_revision_out_of_bounds"));
  assert.equal(forgedRevision.acceptedForHumanReview, false);

  const stricter = independentlyReviewMockScript(event, script, claims, policy, provenance, now, {
    ...limits,
    maxMicroUsd: 1,
  });
  assert.ok(stricter.reasons.includes("script_budget_exceeded"));
  assert.throws(() =>
    independentlyReviewMockScript(event, script, claims, policy, provenance, now, {
      ...limits,
      maxRevisions: 100,
    }),
  );
});

test("independent QA fails closed on corrupt sections instead of accepting them", () => {
  const script = generateBoundedMockScript(event, profile, claims, scaffold, limits, 1);
  const corrupted = {
    ...script,
    sections: [{ narration: null, claimIds: ["claim_one"] }],
  } as unknown as typeof script;
  const review = independentlyReviewMockScript(
    event,
    corrupted,
    claims,
    policy,
    provenance,
    now,
    limits,
  );
  assert.equal(review.acceptedForHumanReview, false);
  assert.ok(review.reasons.includes("script_sections_invalid"));
});

test("weighted ranking uses whole Unicode phrases instead of substring blocklist matches", () => {
  const headline = "Science award recognizes an important public research project";
  const normalized = normalizeFeedArticles(
    articles.map((article) => ({
      sourceId: article.sourceId,
      url: article.url,
      headline,
      publishedAt: article.publishedAt,
      reviewStatus: "candidate" as const,
    })),
  );
  const candidate = { ...event, headline, articles: normalized };
  const withWar = assessEditorialCandidate(
    candidate,
    { ...profile, keywords: ["war"] },
    { ...policy, blockedTerms: ["war"] },
    provenance,
    now,
  );
  const withoutKeyword = assessEditorialCandidate(
    candidate,
    { ...profile, keywords: [] },
    { ...policy, blockedTerms: [] },
    provenance,
    now,
  );
  assert.equal(withWar.eligible, true);
  assert.equal(withWar.score, withoutKeyword.score);
  assert.equal(
    assessEditorialCandidate(
      candidate,
      profile,
      { ...policy, blockedTerms: ["SCIENCE-AWARD"] },
      provenance,
      now,
    ).eligible,
    false,
  );
  assert.ok(
    assessEditorialCandidate(
      candidate,
      profile,
      { ...policy, blockedTerms: ["science award"] },
      provenance,
      now,
    ).reasons.includes("editorial_blocklisted"),
  );
});

test("weighted ranking rejects forged normalized article hashes and display headlines", () => {
  for (const forged of [
    { ...event, headline: "A fabricated unrelated science study" },
    { ...event, articles: [{ ...articles[0]!, id: "f".repeat(64) }, articles[1]!] },
    { ...event, articles: [{ ...articles[0]!, titleFingerprint: "f".repeat(64) }, articles[1]!] },
    { ...event, articles: [{ ...articles[0]!, sourceId: "foreign_source" }, articles[1]!] },
    {
      ...event,
      articles: [{ ...articles[0]!, url: "https://tampered.example.org/story" }, articles[1]!],
    },
  ]) {
    assert.throws(() => assessEditorialCandidate(forged, profile, policy, provenance, now));
  }
});

test("independent QA refuses forged event metadata even if the script itself is intact", () => {
  const script = generateBoundedMockScript(event, profile, claims, scaffold, limits, 1);
  const tampered = {
    ...event,
    articles: [{ ...articles[0]!, titleFingerprint: "f".repeat(64) }, articles[1]!],
  };
  const report = independentlyReviewMockScript(
    tampered,
    script,
    claims,
    policy,
    provenance,
    now,
    limits,
  );
  assert.equal(report.acceptedForHumanReview, false);
  assert.equal(report.approvedForPublication, false);
  assert.ok(report.reasons.includes("event_metadata_mismatch"));
});

test("script generation refuses forged event metadata before producing any sections", () => {
  for (const invalid of [
    { ...event, headline: "Unrelated fabricated science report" },
    { ...event, articles: [{ ...articles[0]!, id: "f".repeat(64) }, articles[1]!] },
    { ...event, articles: [{ ...articles[0]!, titleFingerprint: "f".repeat(64) }, articles[1]!] },
    {
      ...event,
      articles: [{ ...articles[0]!, url: "https://forged.example.org/story" }, articles[1]!],
    },
  ]) {
    assert.throws(() => generateBoundedMockScript(invalid, profile, claims, scaffold, limits, 1));
  }
});

test("script generation refuses orphaned, duplicated and disputed claim references", () => {
  for (const invalid of [
    [{ ...claims[0]!, articleIds: ["unrelated_article_id"] }],
    [{ ...claims[0]!, articleIds: [articles[0]!.id, articles[0]!.id] }],
    [{ ...claims[0]!, status: "disputed" as const }],
    [{ ...claims[0]!, status: "rejected" as const }],
    [{ ...claims[0]!, articleIds: [] }],
  ]) {
    assert.throws(
      () => generateBoundedMockScript(event, profile, invalid, scaffold, limits, 1),
      /Script claim candidate invalid/,
    );
  }
  const generated = generateBoundedMockScript(event, profile, claims, scaffold, limits, 1);
  assert.deepEqual(generated.sections[0]!.claimIds, ["claim_one"]);
  assert.equal(generated.approvedForPublication, false);
});


test("reviewed event factors separately weight visual suitability, explanatory value and risk", () => {
  const weighted = {
    ...policy,
    visualizabilityWeight: 30,
    riskWeight: 20,
    maximumRisk: 3,
  };
  const withoutFactors = assessEditorialCandidate(event, profile, weighted, provenance, now);
  assert.equal(withoutFactors.eligible, false);
  assert.equal(withoutFactors.score, 0);
  assert.ok(withoutFactors.reasons.includes("reviewed_editorial_factors_missing"));

  const factors = {
    eventId: event.id,
    revision: 1,
    explanatoryValue: 4,
    visualizability: 5,
    risk: 1,
  };
  const ranked = assessEditorialCandidate(event, profile, weighted, provenance, now, factors);
  const lessVisual = assessEditorialCandidate(
    event,
    profile,
    weighted,
    provenance,
    now,
    { ...factors, visualizability: 0 },
  );
  const higherRisk = assessEditorialCandidate(
    event,
    profile,
    weighted,
    provenance,
    now,
    { ...factors, risk: 3 },
  );
  assert.equal(ranked.eligible, true);
  assert.equal(ranked.approvedForPublication, undefined);
  assert.equal(ranked.score - lessVisual.score, 30);
  assert.ok(ranked.score > higherRisk.score);
  assert.equal(
    assessEditorialCandidate(event, profile, weighted, provenance, now, {
      ...factors,
      risk: 4,
    }).eligible,
    false,
  );
  assert.throws(() =>
    assessEditorialCandidate(event, profile, weighted, provenance, now, {
      ...factors,
      eventId: "f".repeat(64),
    }),
  );
  assert.throws(() =>
    assessEditorialCandidate(event, profile, weighted, provenance, now, {
      ...factors,
      visualizability: -1,
    }),
  );
  assert.throws(() =>
    assessEditorialCandidate(
      event,
      profile,
      { ...weighted, riskWeight: 101 },
      provenance,
      now,
      factors,
    ),
  );
});
