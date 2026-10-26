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
  for (const entry of [...value.keywords, ...value.blockedTerms]) {
    if (typeof entry !== "string" || !/^[\p{L}\p{N} -]{2,50}$/u.test(entry)) {
      throw new Error("Editorial profile term invalid");
    }
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

export function rankOfflineEvents(
  events: readonly NewsEvent[],
  profile: EditorialProfile,
  now: Date,
): readonly NewsEvent[] {
  validateEditorialProfile(profile);
  if (Number.isNaN(now.getTime())) throw new Error("Ranking clock invalid");
  const blocked = profile.blockedTerms.map((term) => term.toLowerCase());
  const keywords = profile.keywords.map((term) => term.toLowerCase());
  return events
    .flatMap((event) => {
      const title = event.headline.toLowerCase();
      if (blocked.some((term) => title.includes(term))) return [];
      const publishers = new Set(event.articles.map((article) => article.sourceId));
      if (publishers.size < profile.minIndependentSources) return [];
      const newest = Math.max(...event.articles.map((article) => Date.parse(article.publishedAt)));
      const ageHours = (now.getTime() - newest) / 3600000;
      if (ageHours < 0 || ageHours > profile.maximumArticleAgeHours) return [];
      const matches = keywords.filter((term) => title.includes(term)).length;
      return [
        {
          ...event,
          score:
            matches * 10 +
            publishers.size * 3 +
            Math.max(0, Math.floor(profile.maximumArticleAgeHours - ageHours)),
          reasons: [
            `keyword_matches:${matches}`,
            `independent_sources:${publishers.size}`,
            `age_hours:${Math.floor(ageHours)}`,
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
    if (claim.status !== "verified") reasons.push("unverified_claim");
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
