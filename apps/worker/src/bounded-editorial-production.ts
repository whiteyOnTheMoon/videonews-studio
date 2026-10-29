import { createHash } from "node:crypto";
import {
  attestEditorialEventMetadata,
  matchesEditorialPhrase,
  validateEditorialProfile,
  type EditorialProfile,
  type NewsEvent,
} from "./offline-editorial-pipeline.js";

const IDENTIFIER = /^[a-z][a-z0-9_-]{2,40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export interface SourceProvenance {
  sourceId: string;
  publisherGroup: string;
  rightsApproved: boolean;
  quality: number;
}
export interface WeightedRankingPolicy {
  maxAgeHours: number;
  minimumPublisherGroups: number;
  relevanceWeight: number;
  freshnessWeight: number;
  qualityWeight: number;
  explanatoryWeight: number;
  blockedTerms: readonly string[];
}
export interface CandidateAssessment {
  eventId: string;
  eligible: boolean;
  score: number;
  publisherGroups: number;
  reasons: readonly string[];
}

/** Deterministic metadata-based triage; publisher group is NOT an attestation. */
export function assessEditorialCandidate(
  event: NewsEvent,
  profile: EditorialProfile,
  policy: WeightedRankingPolicy,
  provenance: readonly SourceProvenance[],
  now: Date,
): CandidateAssessment {
  validateEditorialProfile(profile);
  if (
    !now ||
    !Number.isFinite(now.getTime()) ||
    !event ||
    !DIGEST.test(event.id) ||
    event.articles.length < 1 ||
    event.articles.length > 100 ||
    !Number.isSafeInteger(policy.maxAgeHours) ||
    policy.maxAgeHours < 1 ||
    policy.maxAgeHours > 720 ||
    !Number.isSafeInteger(policy.minimumPublisherGroups) ||
    policy.minimumPublisherGroups < 2 ||
    policy.minimumPublisherGroups > 5 ||
    !Array.isArray(policy.blockedTerms) ||
    policy.blockedTerms.length > 30
  ) {
    throw new Error("Editorial assessment configuration invalid");
  }
  attestEditorialEventMetadata(event);
  const weights = [
    policy.relevanceWeight,
    policy.freshnessWeight,
    policy.qualityWeight,
    policy.explanatoryWeight,
  ];
  if (weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0 || weight > 100)) {
    throw new Error("Editorial assessment weights invalid");
  }
  if (
    policy.blockedTerms.some(
      (term) => typeof term !== "string" || !/^[\p{L}\p{N} -]{2,50}$/u.test(term),
    )
  ) {
    throw new Error("Editorial assessment blocklist invalid");
  }
  const sourceIds = new Set(event.articles.map((article) => article.sourceId));
  const declared = new Map<string, SourceProvenance>();
  for (const source of provenance) {
    if (
      !source ||
      !IDENTIFIER.test(source.sourceId) ||
      !IDENTIFIER.test(source.publisherGroup) ||
      !Number.isSafeInteger(source.quality) ||
      source.quality < 0 ||
      source.quality > 5 ||
      typeof source.rightsApproved !== "boolean" ||
      declared.has(source.sourceId)
    ) {
      throw new Error("Editorial source provenance invalid");
    }
    declared.set(source.sourceId, source);
  }
  const reasons: string[] = [];
  if ([...sourceIds].some((id) => !declared.has(id))) reasons.push("source_provenance_missing");
  if ([...sourceIds].some((id) => declared.get(id)?.rightsApproved !== true)) {
    reasons.push("source_rights_missing");
  }
  const groups = new Set(
    [...sourceIds].map((id) => declared.get(id)?.publisherGroup).filter(Boolean),
  );
  if (groups.size < policy.minimumPublisherGroups) reasons.push("publisher_groups_insufficient");
  const timestamps = event.articles.map((article) => Date.parse(article.publishedAt));
  if (
    timestamps.some(
      (time) =>
        !Number.isFinite(time) ||
        time > now.getTime() ||
        now.getTime() - time > policy.maxAgeHours * 3600000,
    )
  ) {
    reasons.push("stale_or_future_article");
  }
  const combinedBlocklist = [...profile.blockedTerms, ...policy.blockedTerms];
  if (combinedBlocklist.some((term) => matchesEditorialPhrase(event.headline, term))) {
    reasons.push("editorial_blocklisted");
  }
  const keywords = profile.keywords.filter((term) =>
    matchesEditorialPhrase(event.headline, term),
  ).length;
  const newest = Math.max(...timestamps);
  const hours = Math.max(0, (now.getTime() - newest) / 3600000);
  const quality = [...sourceIds].reduce((sum, id) => sum + (declared.get(id)?.quality ?? 0), 0);
  const qualityMean = quality / sourceIds.size;
  const score = reasons.length
    ? 0
    : Math.max(
        0,
        Math.round(
          keywords * policy.relevanceWeight +
            Math.max(0, 1 - hours / policy.maxAgeHours) * policy.freshnessWeight +
            (qualityMean / 5) * policy.qualityWeight +
            Math.min(groups.size, 5) * policy.explanatoryWeight,
        ),
      );
  return {
    eventId: event.id,
    eligible: reasons.length === 0,
    score,
    publisherGroups: groups.size,
    reasons: reasons.length
      ? [...new Set(reasons)].sort()
      : ["metadata_candidate_only", "independent_confirmation_not_established"],
  };
}

export interface ClaimCandidate {
  id: string;
  statement: string;
  articleIds: readonly string[];
  status: "unverified" | "disputed" | "rejected";
}
export interface ScriptScaffold {
  briefing: string;
  analysis: string;
  explainer: string;
}
export interface ScriptLimits {
  maxCharacters: number;
  maxMockTokens: number;
  maxMicroUsd: number;
  mockMicroUsdPerToken: number;
  maxRevisions: number;
}
export interface BoundedMockScript {
  version: 1;
  revision: number;
  format: EditorialProfile["format"];
  language: string;
  eventId: string;
  sections: readonly { narration: string; claimIds: readonly string[] }[];
  estimatedMockTokens: number;
  estimatedMicroUsd: number;
  provider: "offline_mock";
  approvedForPublication: false;
}

/** No generated factual prose and no external provider. Only reviewed templates and claim IDs. */
export function generateBoundedMockScript(
  event: NewsEvent,
  profile: EditorialProfile,
  claims: readonly ClaimCandidate[],
  scaffold: ScriptScaffold,
  limits: ScriptLimits,
  revision: number,
): BoundedMockScript {
  validateEditorialProfile(profile);
  if (
    !event ||
    !DIGEST.test(event.id) ||
    !Array.isArray(claims) ||
    claims.length < 1 ||
    claims.length > 30 ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(limits.maxRevisions) ||
    limits.maxRevisions < 1 ||
    limits.maxRevisions > 3 ||
    revision > limits.maxRevisions ||
    !Number.isSafeInteger(limits.maxCharacters) ||
    limits.maxCharacters < 20 ||
    limits.maxCharacters > 20000 ||
    !Number.isSafeInteger(limits.maxMockTokens) ||
    limits.maxMockTokens < 1 ||
    limits.maxMockTokens > 10000 ||
    !Number.isSafeInteger(limits.maxMicroUsd) ||
    limits.maxMicroUsd < 0 ||
    !Number.isSafeInteger(limits.mockMicroUsdPerToken) ||
    limits.mockMicroUsdPerToken < 0 ||
    limits.mockMicroUsdPerToken > 1000
  ) {
    throw new Error("Mock script generation not authorized");
  }
  // The generator must reject tampered event metadata itself, not rely on
  // a later QA pass to discover forged source/article identities.
  attestEditorialEventMetadata(event);
  const articleIds = new Set(event.articles.map((article) => article.id));
  const text = scaffold[profile.format];
  if (
    typeof text !== "string" ||
    text.trim() !== text ||
    text.length < 20 ||
    text.length > 2000 ||
    Array.from(text).some((letter) => letter.charCodeAt(0) < 32)
  ) {
    throw new Error("Script scaffold invalid");
  }
  const ids = new Set<string>();
  for (const claim of claims) {
    if (
      !claim ||
      !IDENTIFIER.test(claim.id) ||
      ids.has(claim.id) ||
      typeof claim.statement !== "string" ||
      claim.statement.length < 8 ||
      claim.statement.length > 2000 ||
      !Array.isArray(claim.articleIds) ||
      claim.articleIds.length < 1 ||
      claim.articleIds.length > 20 ||
      new Set(claim.articleIds).size !== claim.articleIds.length ||
      claim.articleIds.some((id) => typeof id !== "string" || !articleIds.has(id)) ||
      claim.status !== "unverified"
    ) {
      throw new Error("Script claim candidate invalid");
    }
    ids.add(claim.id);
  }
  const sections = claims.map((claim) => ({
    narration: text,
    claimIds: [claim.id],
  }));
  const totalCharacters = sections.reduce((sum, section) => sum + section.narration.length, 0);
  const estimatedMockTokens = Math.ceil(totalCharacters / 4);
  const estimatedMicroUsd = estimatedMockTokens * limits.mockMicroUsdPerToken;
  if (
    totalCharacters > limits.maxCharacters ||
    estimatedMockTokens > limits.maxMockTokens ||
    estimatedMicroUsd > limits.maxMicroUsd
  ) {
    throw new Error("Script budget exceeded");
  }
  return {
    version: 1,
    revision,
    format: profile.format,
    language: profile.language,
    eventId: event.id,
    sections,
    estimatedMockTokens,
    estimatedMicroUsd,
    provider: "offline_mock",
    approvedForPublication: false,
  };
}

/**
 * Separate deterministic structural QA path. It cannot certify provenance,
 * factual support, copyright clearance or independent human review.
 */
export function independentlyReviewMockScript(
  event: NewsEvent,
  script: BoundedMockScript,
  claims: readonly ClaimCandidate[],
  policy: WeightedRankingPolicy,
  provenance: readonly SourceProvenance[],
  now: Date,
  limits: ScriptLimits,
): {
  acceptedForHumanReview: boolean;
  approvedForPublication: false;
  reasons: readonly string[];
  digest: string;
} {
  const reasons: string[] = [];
  // Independently supplied operator limits are required. Never trust a
  // script's own claimed cost, budget or maximum permitted revision.
  if (
    !limits ||
    !Number.isSafeInteger(limits.maxCharacters) ||
    limits.maxCharacters < 20 ||
    limits.maxCharacters > 20000 ||
    !Number.isSafeInteger(limits.maxMockTokens) ||
    limits.maxMockTokens < 1 ||
    limits.maxMockTokens > 10000 ||
    !Number.isSafeInteger(limits.maxMicroUsd) ||
    limits.maxMicroUsd < 0 ||
    !Number.isSafeInteger(limits.mockMicroUsdPerToken) ||
    limits.mockMicroUsdPerToken < 0 ||
    limits.mockMicroUsdPerToken > 1000 ||
    !Number.isSafeInteger(limits.maxRevisions) ||
    limits.maxRevisions < 1 ||
    limits.maxRevisions > 3
  ) {
    throw new Error("Independent script budget policy invalid");
  }
  if (
    !script ||
    script.eventId !== event.id ||
    script.provider !== "offline_mock" ||
    script.approvedForPublication !== false ||
    !Number.isSafeInteger(script.revision)
  ) {
    throw new Error("Independent script input invalid");
  }
  if (script.revision < 1 || script.revision > limits.maxRevisions) {
    reasons.push("script_revision_out_of_bounds");
  }
  try {
    attestEditorialEventMetadata(event);
  } catch {
    reasons.push("event_metadata_mismatch");
  }
  const articleIds = new Set(event.articles.map((article) => article.id));
  const claimMap = new Map<string, ClaimCandidate>();
  for (const claim of claims) {
    if (claimMap.has(claim.id)) reasons.push("duplicate_claim");
    claimMap.set(claim.id, claim);
    if (claim.status !== "unverified") reasons.push("claim_disputed_or_rejected");
    if (!claim.articleIds.length || claim.articleIds.some((id) => !articleIds.has(id))) {
      reasons.push("claim_evidence_mismatch");
    }
  }
  const sections = Array.isArray(script.sections) ? script.sections : [];
  if (!sections.length || sections.length > 30) reasons.push("script_sections_invalid");
  let characters = 0;
  const represented = new Set<string>();
  for (const section of sections) {
    if (
      !section ||
      typeof section.narration !== "string" ||
      !Array.isArray(section.claimIds) ||
      !section.claimIds.every((id: unknown) => typeof id === "string")
    ) {
      reasons.push("script_sections_invalid");
      continue;
    }
    characters += section.narration.length;
    if (!section.narration.trim() || !section.claimIds.length) {
      reasons.push("unattributed_script_section");
    }
    for (const id of section.claimIds) {
      represented.add(id);
      if (!claimMap.has(id)) reasons.push("unknown_claim_reference");
    }
    if (event.articles.some((article) => section.narration.includes(article.headline))) {
      reasons.push("source_text_similarity_risk");
    }
  }
  for (const claim of claims) {
    if (!represented.has(claim.id)) reasons.push("unrepresented_claim");
  }
  const actualTokens = Math.ceil(characters / 4);
  const actualMicroUsd = actualTokens * limits.mockMicroUsdPerToken;
  if (
    characters > limits.maxCharacters ||
    actualTokens > limits.maxMockTokens ||
    actualMicroUsd > limits.maxMicroUsd
  ) {
    reasons.push("script_budget_exceeded");
  }
  if (
    actualTokens < 1 ||
    script.estimatedMockTokens !== actualTokens ||
    script.estimatedMicroUsd !== actualMicroUsd
  ) {
    reasons.push("script_cost_integrity_mismatch");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    reasons.push("invalid_review_clock");
  }
  const provenanceBySource = new Map(
    provenance.map((source) => [source.sourceId, source] as const),
  );
  const sourceIds = new Set(event.articles.map((article) => article.sourceId));
  if (
    provenanceBySource.size !== provenance.length ||
    [...sourceIds].some((id) => !provenanceBySource.has(id))
  ) {
    reasons.push("source_provenance_missing");
  }
  if ([...sourceIds].some((id) => provenanceBySource.get(id)?.rightsApproved !== true)) {
    reasons.push("source_rights_missing");
  }
  if (
    !Number.isSafeInteger(policy.minimumPublisherGroups) ||
    policy.minimumPublisherGroups < 2 ||
    new Set([...sourceIds].map((id) => provenanceBySource.get(id)?.publisherGroup)).size <
      policy.minimumPublisherGroups
  ) {
    reasons.push("publisher_groups_insufficient");
  }
  if (!Number.isSafeInteger(policy.maxAgeHours) || policy.maxAgeHours < 1) {
    reasons.push("invalid_freshness_policy");
  } else if (
    event.articles.some((article) => {
      const timestamp = Date.parse(article.publishedAt);
      return (
        !Number.isFinite(timestamp) ||
        timestamp > now.getTime() ||
        now.getTime() - timestamp > policy.maxAgeHours * 3600000
      );
    })
  ) {
    reasons.push("stale_or_future_article");
  }
  reasons.push("independent_claim_verification_required");
  reasons.push("manual_copyright_and_fact_review_required");
  const finalReasons = [...new Set(reasons)].sort();
  return {
    acceptedForHumanReview: reasons.every((reason) =>
      [
        "independent_claim_verification_required",
        "manual_copyright_and_fact_review_required",
      ].includes(reason),
    ),
    approvedForPublication: false,
    reasons: finalReasons,
    digest: hash(JSON.stringify({ eventId: event.id, script, reasons: finalReasons })),
  };
}
