import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import EditorialProfiles, {
  parseEditorialProfileSnapshot,
  validEditorialProfileTerms,
} from "./editorial-profiles";
import EditorialAuditExport, {
  validEditorialExportBatch,
  validEditorialExportTerminator,
} from "./editorial-audit-export";
import EditorialCheckpointEntry from "./editorial-checkpoint-entry";
import EditorialTimelineEntry from "./editorial-timeline-entry";
import EditorialFeedInbox from "./editorial-feed-inbox";
import { parseFeedInboxPage } from "../../lib/editorial-feed-inbox";
import EditorialRankedEvents, {
  parseRankedCandidatePage,
  mayDisplayRankedCandidates,
  RANKED_CANDIDATE_EMPTY_EXPLANATION,
} from "./editorial-ranked-events";
import EditorialRankingPolicy from "./editorial-ranking-policy";
import EditorialMetadataReviews from "./editorial-metadata-reviews";
import {
  validPublisherReviewWrite,
  validPublisherReviewSnapshot,
  validEventFactorReviewWrite,
  validEventFactorReviewSnapshot,
  validMetadataReviewSaved,
} from "../../lib/editorial-review-metadata";
import {
  validRankingPolicyCommit,
  validRankingPolicySettings,
  validRankingPolicySnapshot,
} from "../../lib/editorial-ranking-policy";

const profile = {
  id: "science_news",
  language: "de-DE",
  keywords: ["science"],
  blockedTerms: [],
  minIndependentSources: 2,
  maximumArticleAgeHours: 24,
  format: "briefing",
};
test("profile editor renders no forms until enabled and authenticated load succeeds", () => {
  const disabled = renderToStaticMarkup(<EditorialProfiles enabled={false} />);
  assert.match(disabled, /Profilverwaltung nicht freigeschaltet/);
  assert.doesNotMatch(disabled, /<form|<input|<select|science_news/);
  const enabled = renderToStaticMarkup(<EditorialProfiles enabled />);
  assert.match(enabled, /Lade Profile/);
  assert.doesNotMatch(enabled, /<form|<input|<select/);
});

test("only structurally valid and unique profile revisions enter the Admin UI", () => {
  assert.deepEqual(parseEditorialProfileSnapshot({ revision: 4, profiles: [profile] }), {
    revision: 4,
    profiles: [profile],
  });
  for (const candidate of [
    { revision: -1, profiles: [] },
    { revision: 1, profiles: [profile, profile] },
    { revision: 1, profiles: [{ ...profile, sourceToken: "private" }] },
    { revision: 1, profiles: [{ ...profile, language: "bad locale" }] },
    { revision: 1, profiles: [{ ...profile, keywords: ["science", "SCIENCE"] }] },
    { revision: 1, profiles: [{ ...profile, keywords: ["science news", "science-news"] }] },
    { revision: 1, profiles: [{ ...profile, keywords: ["--"] }] },
    { revision: 1, profiles: [{ ...profile, blockedTerms: ["SCIENCE"] }] },
    { revision: 1, profiles: [{ ...profile, keywords: Array(31).fill("science") }] },
  ]) {
    assert.equal(parseEditorialProfileSnapshot(candidate), null);
  }
});

test("audit export is disabled by default and never renders a file control", () => {
  const disabled = renderToStaticMarkup(<EditorialAuditExport enabled={false} />);
  assert.match(disabled, /Export noch nicht freigeschaltet/);
  assert.doesNotMatch(disabled, /<form|<input|<button/);
  const enabled = renderToStaticMarkup(<EditorialAuditExport enabled />);
  assert.match(enabled, /Vollständigen JSON-Export/);
  assert.match(enabled, /disabled/);
});

test("audit export envelope rejects missing or forged page metadata", () => {
  const checkpoint = { events: [], nextRevision: 0 };
  const timeline = { events: [], cursor: null };
  assert.equal(validEditorialExportBatch(checkpoint, "checkpoints"), true);
  assert.equal(validEditorialExportBatch(timeline, "timeline"), true);
  for (const bad of [
    { events: [], nextRevision: 0, leakedSecret: "forbidden" },
    { events: [], nextRevision: -1 },
    { events: [], nextRevision: 1.5 },
    { events: [], cursor: null },
    { events: ["forged string"], nextRevision: 0 },
    { events: Array.from({ length: 101 }, () => ({})), nextRevision: 0 },
  ]) {
    assert.equal(validEditorialExportBatch(bad, "checkpoints"), false);
  }
  for (const bad of [
    { events: [] },
    { events: [], cursor: {} },
    { events: [], cursor: null, extra: "unreviewed" },
    { events: [], cursor: { afterTime: "not-a-time", afterId: "invalid" } },
    { events: Array.from({ length: 101 }, () => ({})), cursor: null },
  ]) {
    assert.equal(validEditorialExportBatch(bad, "timeline"), false);
  }
});

test("checkpoint entry is hidden until feature opt-in and never publishes", () => {
  const hidden = renderToStaticMarkup(<EditorialCheckpointEntry enabled={false} />);
  assert.match(hidden, /Prüfprotokoll nicht freigeschaltet/);
  assert.doesNotMatch(hidden, /<form|<input|<select/);
  const active = renderToStaticMarkup(<EditorialCheckpointEntry enabled />);
  assert.match(active, /Ereignis-UUID/);
  assert.match(active, /Qualität/);
  assert.match(active, /Prüfentscheidung speichern/);
  assert.doesNotMatch(active, /veröffentlichen|Upload starten|Freigabe erteilen/i);
});

test("Story audit entry shows no form by default and no publishing controls", () => {
  const dormant = renderToStaticMarkup(<EditorialTimelineEntry enabled={false} />);
  assert.match(dormant, /Story-Protokoll nicht freigeschaltet/);
  assert.doesNotMatch(dormant, /<form|<input|<textarea/);
  const enabled = renderToStaticMarkup(<EditorialTimelineEntry enabled />);
  assert.match(enabled, /Abgelehnte Aussage/);
  assert.match(enabled, /Story-Ereignis speichern/);
  assert.doesNotMatch(enabled, /Jetzt veröffentlichen/);
});

test("audit export terminator never accepts changed checkpoint cursor or nonempty timeline cursor", () => {
  const emptyCheckpoint = { events: [], nextRevision: 4 };
  assert.equal(validEditorialExportTerminator("checkpoints", emptyCheckpoint, 4), true);
  assert.equal(validEditorialExportTerminator("checkpoints", emptyCheckpoint, 3), false);
  assert.equal(
    validEditorialExportTerminator("checkpoints", { events: [{}], nextRevision: 4 }, 4),
    false,
  );
  assert.equal(validEditorialExportTerminator("timeline", { events: [], cursor: null }, 0), true);
  assert.equal(
    validEditorialExportTerminator(
      "timeline",
      {
        events: [],
        cursor: {
          afterTime: "2026-10-26T12:00:00.000Z",
          afterId: "ca310001-1111-4111-8111-111111111111",
        },
      },
      0,
    ),
    false,
  );
});

test("Admin profile editor rejects tokenless and duplicated terms before saving", () => {
  assert.equal(validEditorialProfileTerms(["science", "space research"], ["sponsored"]), true);
  assert.equal(validEditorialProfileTerms(["science", "SCIENCE"], []), false);
  assert.equal(validEditorialProfileTerms(["science-news", "science news"], []), false);
  assert.equal(validEditorialProfileTerms(["--"], []), false);
  assert.equal(validEditorialProfileTerms(["science"], ["Science"]), false);
  assert.equal(validEditorialProfileTerms(["news"], ["token\\value"]), false);
  assert.equal(validEditorialProfileTerms(Array(31).fill("news"), []), false);
});

test("an earlier ranking is never rendered during refresh, error or disabled admission", () => {
  assert.equal(mayDisplayRankedCandidates(true, false, "", 1), true);
  for (const args of [
    [true, true, "", 1],
    [true, false, "rankings unavailable", 1],
    [false, false, "", 1],
    [true, false, "", 0],
  ] as const) {
    assert.equal(mayDisplayRankedCandidates(args[0], args[1], args[2], args[3]), false);
  }
});

test("P2-04 ranked snapshots stay hidden until personal Admin admission", () => {
  const disabled = renderToStaticMarkup(<EditorialRankedEvents enabled={false} />);
  assert.match(disabled, /Rankingansicht nicht freigeschaltet/);
  assert.doesNotMatch(disabled, /<button|<ol/);
  const enabled = renderToStaticMarkup(<EditorialRankedEvents enabled />);
  assert.match(enabled, /Lade Ranking/);
  assert.doesNotMatch(enabled, /<ol/);
});

test("P2-04 empty ranking does not claim absence of persisted metadata or bypass eligibility", () => {
  assert.match(RANKED_CANDIDATE_EMPTY_EXPLANATION, /Feed-Artikel und Rechercheereignisse/);
  assert.match(RANKED_CANDIDATE_EMPTY_EXPLANATION, /Quellen-IDs/);
  assert.match(RANKED_CANDIDATE_EMPTY_EXPLANATION, /Altersfenster/);
  assert.match(RANKED_CANDIDATE_EMPTY_EXPLANATION, /Prüfungen/);
  assert.doesNotMatch(RANKED_CANDIDATE_EMPTY_EXPLANATION, /keine Nachrichten eingegangen/i);
});

test("P2-04 Admin refuses unverifiable and publishing-enabled ranking snapshots", () => {
  const candidate = {
    eventId: "ca310002-2222-4222-8222-222222222222",
    profileId: "science_news",
    profileRevision: 1,
    headline: "Synthetic research science candidate not independently verified",
    score: 23,
    articleCount: 2,
    sourceCount: 1,
    reasons: ["metadata_candidate_only", "independent_verification_required"],
    rankedAt: "2026-10-28T12:00:00.000Z",
    approvedForPublication: false,
  };
  assert.deepEqual(parseRankedCandidatePage({ candidates: [candidate], metadataOnly: true }), [
    candidate,
  ]);
  for (const bad of [
    { candidates: [{ ...candidate, approvedForPublication: true }], metadataOnly: true },
    { candidates: [{ ...candidate, reasons: ["unverified"] }], metadataOnly: true },
    { candidates: [{ ...candidate, profileRevision: -1 }], metadataOnly: true },
    { candidates: [{ ...candidate, extraApiToken: "private" }], metadataOnly: true },
    { candidates: [candidate], metadataOnly: false },
  ])
    assert.equal(parseRankedCandidatePage(bad), null);
});

test("P2-04 ranking review UI is hidden until personal Admin activation", () => {
  const disabled = renderToStaticMarkup(<EditorialRankingPolicy enabled={false} />);
  assert.match(disabled, /Ranking-Policy-Prüfung nicht freigeschaltet/);
  assert.doesNotMatch(disabled, /<form|<input|<button/);
  const enabled = renderToStaticMarkup(<EditorialRankingPolicy enabled />);
  assert.match(enabled, /Profil-ID/);
  assert.match(enabled, /Policy laden/);
  assert.doesNotMatch(enabled, /Geprüfte Gewichtung speichern/);
  assert.doesNotMatch(enabled, /Upload starten|Jetzt veröffentlichen/);
});

test("review form and BFF strictly reject changed policy shape or forged publishing", () => {
  const settings = {
    minimumPublisherGroups: 2,
    relevanceWeight: 10,
    freshnessWeight: 20,
    qualityWeight: 15,
    explanatoryWeight: 5,
    visualizabilityWeight: 30,
    riskWeight: 20,
    maximumRisk: 3,
  };
  const current = {
    profileId: "science_news",
    profileRevision: 1,
    policyRevision: 1,
    settings,
    productionActive: false,
  };
  assert.equal(validRankingPolicySettings(settings), true);
  assert.equal(validRankingPolicySnapshot(current), true);
  assert.equal(
    validRankingPolicyCommit({
      saved: true,
      policyRevision: 2,
      productionActive: false,
    }),
    true,
  );
  for (const bad of [
    { ...settings, riskWeight: -1 },
    { ...settings, maximumRisk: 6 },
    { ...settings, minimumPublisherGroups: 1 },
    { ...settings, unsupported: 1 },
  ])
    assert.equal(validRankingPolicySettings(bad), false);
  for (const bad of [
    { ...current, productionActive: true },
    { ...current, profileRevision: -1 },
    { ...current, settings: { ...settings, publisherSecret: "forged" } },
    { ...current, policyRevision: 0 },
    { ...current, settings: null },
  ])
    assert.equal(validRankingPolicySnapshot(bad), false);
  assert.equal(
    validRankingPolicyCommit({
      saved: true,
      policyRevision: 2,
      productionActive: true,
    }),
    false,
  );
});

test("personal source and event factor forms have no publishing action", () => {
  const disabled = renderToStaticMarkup(<EditorialMetadataReviews enabled={false} />);
  assert.match(disabled, /Persönliche Metadatenprüfungen nicht freigeschaltet/);
  assert.doesNotMatch(disabled, /<form|<input|<button/);
  const enabled = renderToStaticMarkup(<EditorialMetadataReviews enabled />);
  assert.match(enabled, /Freigegebene Quellen-ID/);
  assert.match(enabled, /Ereignis-UUID/);
  assert.doesNotMatch(enabled, /Herausgeberprüfung speichern|Ereignisbewertung speichern/);
  assert.doesNotMatch(enabled, /Jetzt veröffentlichen|Upload starten/);
});

test("review metadata snapshots remain strictly bounded and never authorize publication", () => {
  const pub = {
    sourceId: "science_feed",
    sourceRevision: 5,
    publisherGroup: "science_origin",
    quality: 4,
  };
  const event = {
    eventId: "ca310002-2222-4222-8222-222222222222",
    profileId: "science_news",
    profileRevision: 1,
    policyRevision: 2,
    explanatoryValue: 4,
    visualizability: 5,
    risk: 1,
  };
  assert.equal(validPublisherReviewWrite(pub), true);
  assert.equal(validEventFactorReviewWrite(event), true);
  assert.equal(
    validPublisherReviewSnapshot({
      sourceId: pub.sourceId,
      sourceRevision: pub.sourceRevision,
      reviewed: true,
      publisherGroup: pub.publisherGroup,
      quality: pub.quality,
      approvedForPublication: false,
    }),
    true,
  );
  assert.equal(
    validEventFactorReviewSnapshot({
      ...event,
      reviewed: true,
      approvedForPublication: false,
    }),
    true,
  );
  assert.equal(
    validMetadataReviewSaved({
      saved: true,
      approvedForPublication: false,
    }),
    true,
  );
  for (const bad of [
    { ...pub, reviewerId: "forged" },
    { ...pub, sourceRevision: 0 },
    { ...pub, publisherGroup: "bad!" },
    { ...pub, quality: 6 },
  ])
    assert.equal(validPublisherReviewWrite(bad), false);
  for (const bad of [
    { ...event, actorId: "forged" },
    { ...event, policyRevision: 0 },
    { ...event, explanatoryValue: -1 },
    { ...event, risk: 6 },
  ])
    assert.equal(validEventFactorReviewWrite(bad), false);
  assert.equal(
    validMetadataReviewSaved({
      saved: true,
      approvedForPublication: true,
    }),
    false,
  );
});

test("feed inbox stays unranked and cannot become publication approval", () => {
  const disabled = renderToStaticMarkup(<EditorialFeedInbox enabled={false} />);
  assert.match(disabled, /Nachrichteneingang nicht freigeschaltet/);
  assert.doesNotMatch(disabled, /<button|<ol/);
  const enabled = renderToStaticMarkup(<EditorialFeedInbox enabled />);
  assert.match(enabled, /Nachrichteneingang/);
  assert.doesNotMatch(enabled, /<ol/);
  const entry = {
    sourceId: "noaa_news",
    articleUrl: "https://www.noaa.gov/news/ci-test",
    headline: "Synthetic NOAA headline awaiting independent verification",
    publishedAt: "2026-11-01T12:00:00.000Z",
    projected: false,
    eventId: null,
    approvedForPublication: false,
  };
  const envelope = { metadataOnly: true, rankingApplied: false, items: [entry] };
  assert.deepEqual(parseFeedInboxPage(envelope), [entry]);
  for (const bad of [
    { ...entry, approvedForPublication: true },
    { ...entry, projected: true },
    { ...entry, eventId: "bad" },
    { ...entry, headline: "<script>fake</script>" },
    { ...entry, rawUrl: "https://invalid.example/token" },
    { ...entry, articleUrl: "javascript:alert(1)" },
    { ...entry, articleUrl: "https://www.noaa.gov/news/item?token=secret" },
    { ...entry, articleUrl: "https://www.noaa.gov@evil.example/news/item" },
    { ...entry, articleUrl: "https://127.0.0.1/private" },
    { ...entry, publishedAt: "invalid" },
  ]) {
    assert.equal(
      parseFeedInboxPage({
        metadataOnly: true,
        rankingApplied: false,
        items: [bad],
      }),
      null,
    );
  }
  assert.equal(parseFeedInboxPage({ ...envelope, rankingApplied: true }), null);
});
