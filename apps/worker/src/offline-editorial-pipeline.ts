import { createHash } from "node:crypto";
import type { FeedItem } from "./feed-poller.js";

export interface EditorialProfile {
  id: string;
  language: string;
  keywords: readonly string[];
  blockedTerms: readonly string[];
  minIndependentSources: number;
  maximumArticleAgeHours: number;
  format: "briefing" | "analysis" | "explainer";
}

export interface NormalizedArticle {
  id: string;
  sourceId: string;
  url: string;
  headline: string;
  publishedAt: string;
  titleFingerprint: string;
}

export interface NewsEvent {
  id: string;
  headline: string;
  articles: readonly NormalizedArticle[];
  score: number;
  reasons: readonly string[];
}

export interface ClaimEvidence {
  statement: string;
  articleIds: readonly string[];
  status: "verified" | "uncertain";
}

export interface EditorialDraft {
  format: EditorialProfile["format"];
  language: string;
  headline: string;
  paragraphs: readonly string[];
  claims: readonly ClaimEvidence[];
}

export interface EditorialReport {
  version: 1;
  profileId: string;
  eventId: string;
  sourceUrls: readonly string[];
  decisions: readonly string[];
  draft: EditorialDraft;
  approvedForPublication: false;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function validateEditorialProfile(value: EditorialProfile): EditorialProfile {
  if (
    !/^[a-z][a-z0-9_-]{2,40}$/.test(value.id) ||
    !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(value.language) ||
    !Array.isArray(value.keywords) ||
    !Array.isArray(value.blockedTerms) ||
    value.keywords.length > 30 ||
    value.blockedTerms.length > 30 ||
    ![1, 2, 3, 4, 5].includes(value.minIndependentSources) ||
    !Number.isSafeInteger(value.maximumArticleAgeHours) ||
    value.maximumArticleAgeHours < 1 ||
    value.maximumArticleAgeHours > 720 ||
    !["briefing", "analysis", "explainer"].includes(value.format)
  ) {
    throw new Error("Editorial profile invalid");
  }
  const seenTerms = new Set<string>();
  for (const entry of [...value.keywords, ...value.blockedTerms]) {
    if (typeof entry !== "string" || !/^[\p{L}\p{N} -]{2,50}$/u.test(entry)) {
      throw new Error("Editorial profile term invalid");
    }
    const words = entry
      .normalize("NFKC")
      .toLocaleLowerCase("en")
      .match(/[\p{L}\p{N}]+/gu);
    const key = words?.join(" ");
    if (!key || seenTerms.has(key)) throw new Error("Editorial profile term ambiguous");
    seenTerms.add(key);
  }
  return value;
}

/** Strict metadata only. No external fetch and no article body retention. */
export function normalizeFeedArticles(items: readonly FeedItem[]): readonly NormalizedArticle[] {
  if (items.length > 100) throw new Error("Article batch exceeded");
  const seen = new Set<string>();
  return items.map((item) => {
    if (
      item.reviewStatus !== "candidate" ||
      !/^[a-z][a-z0-9_-]{2,40}$/.test(item.sourceId) ||
      typeof item.headline !== "string" ||
      item.headline.length < 8 ||
      item.headline.length > 200 ||
      !item.publishedAt
    ) {
      throw new Error("Article metadata invalid");
    }
    const url = new URL(item.url);
    if (
      url.protocol !== "https:" ||
      !url.hostname.includes(".") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.toString() !== item.url
    ) {
      throw new Error("Article URL not canonical");
    }
    const millis = Date.parse(item.publishedAt);
    if (!Number.isFinite(millis) || new Date(millis).toISOString() !== item.publishedAt) {
      throw new Error("Article time invalid");
    }
    if (seen.has(item.url)) throw new Error("Duplicate canonical article URL");
    seen.add(item.url);
    const titleFingerprint = hash(
      item.headline
        .toLocaleLowerCase("en")
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim(),
    );
    return {
      id: hash(item.sourceId + "\n" + item.url),
      sourceId: item.sourceId,
      url: item.url,
      headline: item.headline,
      publishedAt: item.publishedAt,
      titleFingerprint,
    };
  });
}

/** Exact normalized headline fingerprint only: no claim of semantic deduplication. */
export function groupExactHeadlineEvents(
  articles: readonly NormalizedArticle[],
): readonly NewsEvent[] {
  const groups = new Map<string, NormalizedArticle[]>();
  for (const article of articles) {
    const group = groups.get(article.titleFingerprint) ?? [];
    group.push(article);
    groups.set(article.titleFingerprint, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fingerprint, records]) => ({
      id: hash("event-v1:" + fingerprint),
      headline: records[0]!.headline,
      articles: records,
      score: 0,
      reasons: [],
    }));
}

/**
 * Preliminary metadata ranking only. A source ID is not publisher
 * independence, and a normalized title is not verified news evidence.
 */
export function rankOfflineEvents(
  events: readonly NewsEvent[],
  profile: EditorialProfile,
  now: Date,
): readonly NewsEvent[] {
  validateEditorialProfile(profile);
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !Array.isArray(events) ||
    events.length > 100
  ) {
    throw new Error("Ranking input invalid");
  }
  const phraseTokens = (value: string): readonly string[] =>
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en")
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const matchesPhrase = (title: string, term: string): boolean => {
    const words = phraseTokens(title);
    const expected = phraseTokens(term);
    return (
      expected.length > 0 &&
      words.some((_, index) => expected.every((word, offset) => words[index + offset] === word))
    );
  };
  const blocked = [...profile.blockedTerms];
  const keywords = [...profile.keywords];
  const seenEvents = new Set<string>();
  return events
    .flatMap((event) => {
      if (
        !event ||
        typeof event.headline !== "string" ||
        !/^[0-9a-f]{64}$/.test(event.id) ||
        seenEvents.has(event.id) ||
        !Array.isArray(event.articles) ||
        event.articles.length < 1 ||
        event.articles.length > 100
      ) {
        throw new Error("Ranking candidate invalid");
      }
      seenEvents.add(event.id);
      const articles: readonly NormalizedArticle[] = event.articles;
      // Standalone ranking may be called with forged, caller-constructed event
      // metadata: verify both immutable article hashes and the display headline
      // before allowing that headline to decide blocklist/keyword results.
      const normalized = normalizeFeedArticles(
        articles.map((article) => ({
          sourceId: article.sourceId,
          url: article.url,
          headline: article.headline,
          publishedAt: article.publishedAt,
          reviewStatus: "candidate" as const,
        })),
      );
      if (
        normalized.some(
          (article, i) =>
            article.id !== articles[i]!.id ||
            article.titleFingerprint !== articles[i]!.titleFingerprint,
        ) ||
        !normalized.some((article) => article.headline === event.headline)
      ) {
        throw new Error("Ranking candidate metadata mismatch");
      }
      const title = event.headline;
      if (blocked.some((term) => matchesPhrase(title, term))) return [];
      const distinctSources = new Set(articles.map((article) => article.sourceId));
      // Historical field name is retained for stored profile compatibility;
      // the threshold counts source IDs, not independent publishers/evidence.
      if (distinctSources.size < profile.minIndependentSources) return [];
      const times = articles.map((article) => Date.parse(article.publishedAt));
      if (
        times.some(
          (value) =>
            value > now.getTime() ||
            now.getTime() - value > profile.maximumArticleAgeHours * 3600000,
        )
      ) {
        return [];
      }
      const ageHours = (now.getTime() - Math.max(...times)) / 3600000;
      const matches = keywords.filter((term) => matchesPhrase(title, term)).length;
      return [
        {
          ...event,
          score:
            matches * 10 +
            distinctSources.size * 3 +
            Math.max(0, Math.floor(profile.maximumArticleAgeHours - ageHours)),
          reasons: [
            `keyword_matches:${matches}`,
            `distinct_source_ids:${distinctSources.size}`,
            `age_hours:${Math.floor(ageHours)}`,
            "independent_verification_required",
          ],
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * Not an LLM. Produces an attributable draft template, with uncertainty
 * explicitly marked; never invent supporting factual statements.
 */
export function buildOfflineDraft(event: NewsEvent, profile: EditorialProfile): EditorialDraft {
  validateEditorialProfile(profile);
  if (!event.articles.length || event.score <= 0) throw new Error("Unranked event refused");
  const claims: ClaimEvidence[] = [
    {
      statement: event.headline,
      articleIds: event.articles.map((article) => article.id),
      status: "uncertain",
    },
  ];
  const introductions = {
    briefing: "Headline summary requiring editorial verification.",
    analysis: "Context and consequences require additional verified evidence.",
    explainer: "Background and definitions require separately verified evidence.",
  };
  return {
    format: profile.format,
    language: profile.language,
    headline: event.headline,
    paragraphs: [introductions[profile.format]],
    claims,
  };
}

export function independentlyCheckDraft(
  event: NewsEvent,
  draft: EditorialDraft,
): { accepted: boolean; reasons: readonly string[] } {
  const ids = new Set(event.articles.map((article) => article.id));
  const reasons: string[] = [];
  if (!draft.claims.length) reasons.push("missing_claims");
  for (const claim of draft.claims) {
    if (
      !claim.statement.trim() ||
      !claim.articleIds.length ||
      claim.articleIds.some((id) => !ids.has(id))
    )
      reasons.push("unattributed_claim");
    if (claim.status !== "verified") {
      reasons.push("unverified_claim");
    } else {
      // A self-reported status is not an independent review attestation.
      // This offline candidate model contains no reviewer identity, signed
      // decision or evidence provenance that could justify acceptance.
      reasons.push("independent_review_not_attested");
    }
  }
  if (!draft.paragraphs.length || draft.paragraphs.some((text) => !text.trim())) {
    reasons.push("empty_draft");
  }
  return { accepted: reasons.length === 0, reasons };
}

export function exportOfflineEditorialReport(
  event: NewsEvent,
  profile: EditorialProfile,
  draft: EditorialDraft,
): EditorialReport {
  const review = independentlyCheckDraft(event, draft);
  return {
    version: 1,
    profileId: profile.id,
    eventId: event.id,
    sourceUrls: event.articles.map((article) => article.url),
    decisions: ["offline_metadata_only", ...event.reasons, ...review.reasons],
    draft,
    approvedForPublication: false,
  };
}

/**
 * Candidate-only near-duplicate clustering. This is lexical matching, not
 * semantic verification. Never equate source count with independent evidence.
 *
 * The all-pairs invariant prevents chaining A≈B≈C when A and C disagree.
 * Ambiguous matches remain separate instead of merging unrelated stories.
 */
export function groupConservativeEventCandidates(
  articles: readonly NormalizedArticle[],
): readonly NewsEvent[] {
  if (articles.length > 100) throw new Error("Event candidate batch exceeded");
  // Never trust caller-supplied hashes: forged fingerprints can merge unrelated
  // headlines and forged IDs can impersonate a different source/URL.
  const verified = normalizeFeedArticles(
    articles.map((article) => ({
      sourceId: article.sourceId,
      url: article.url,
      headline: article.headline,
      publishedAt: article.publishedAt,
      reviewStatus: "candidate" as const,
    })),
  );
  for (let index = 0; index < articles.length; index++) {
    if (
      articles[index]!.id !== verified[index]!.id ||
      articles[index]!.titleFingerprint !== verified[index]!.titleFingerprint
    ) {
      throw new Error("Event candidate identity mismatch");
    }
  }
  const ids = new Set<string>();
  for (const article of articles) {
    if (
      !/^[0-9a-f]{64}$/.test(article.id) ||
      !/^[0-9a-f]{64}$/.test(article.titleFingerprint) ||
      !Number.isFinite(Date.parse(article.publishedAt)) ||
      ids.has(article.id)
    ) {
      throw new Error("Event candidate invalid or duplicated");
    }
    ids.add(article.id);
  }
  const tokens = (text: string): Set<string> =>
    new Set(
      text
        .normalize("NFKC")
        .toLocaleLowerCase("en")
        .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
    );
  const similar = (a: NormalizedArticle, b: NormalizedArticle): boolean => {
    if (Math.abs(Date.parse(a.publishedAt) - Date.parse(b.publishedAt)) > 48 * 3600000) {
      return false;
    }
    if (a.titleFingerprint === b.titleFingerprint) return true;
    const left = tokens(a.headline);
    const right = tokens(b.headline);
    if (left.size < 6 || right.size < 6) return false;
    const shared = [...left].filter((word) => right.has(word)).length;
    return shared >= 6 && shared / new Set([...left, ...right]).size >= 0.8;
  };
  const ordered = [...articles].sort((a, b) => a.id.localeCompare(b.id));
  const groups: NormalizedArticle[][] = [];
  for (const article of ordered) {
    const matches = groups.filter((group) => group.every((member) => similar(article, member)));
    if (matches.length === 1) matches[0]!.push(article);
    else groups.push([article]);
  }
  return groups
    .map((records) => {
      const signature = records
        .map((record) => record.id)
        .sort()
        .join(":");
      return {
        id: hash("candidate-event-v1:" + signature),
        headline: records[0]!.headline,
        articles: records,
        score: 0,
        reasons: ["lexical_candidate_only", "independent_verification_required"],
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
