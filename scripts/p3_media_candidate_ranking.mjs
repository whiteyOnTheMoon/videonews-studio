#!/usr/bin/env node
/**
 * P3-13: deterministic metadata-based scene/asset ranking for reviewer triage.
 * This is NOT visual analysis, semantic verification, license approval or a
 * recommendation to publish. Stock footage is never scientific evidence.
 */
import assert from "node:assert/strict";
import {normalizeSourceCandidate} from "./p3_episode_asset_library.mjs";

const ID = /^beat-(0[1-9]|1[0-9])$/;
const STOP = new Set([
  "a","an","and","are","as","at","by","data","documentary","explained",
  "for","from","in","into","is","it","of","on","our","science","scientific",
  "scene","the","this","to","video","visualization","what","why","with",
]);
const wordTokens = value => new Set(
  String(value ?? "").normalize("NFKC").toLocaleLowerCase("en")
    .match(/[\p{L}\p{N}]{3,}/gu)?.filter(word => !STOP.has(word)) ?? [],
);

function byScore(a, b) {
  return b.score - a.score || a.id.localeCompare(b.id);
}

/**
 * Scores metadata suitability *only*. Missing tags must reduce confidence,
 * not be mistaken for content that has been verified visually.
 */
export function scoreMediaCandidate(scene, candidate) {
  assert.ok(scene && candidate && ID.test(scene.sceneId) &&
    candidate.sceneId === scene.sceneId);
  const isScience = candidate.provider === "nasa";
  const role = isScience ?
    "SCIENTIFIC_SOURCE_REVIEW_REQUIRED" : "CONTEXT_ONLY_NOT_EVIDENCE";
  const needle = wordTokens(scene.label + " " + scene.searchQuery);
  const haystack = wordTokens(candidate.title + " " + candidate.description);
  const overlap = [...needle].filter(word => haystack.has(word));
  const relevance = Math.min(36, overlap.length * 9);
  let score = 10 + relevance;
  const reasons = [];
  if (overlap.length) reasons.push("Keyword overlap: " + overlap.slice(0, 4).join(", "));
  else reasons.push("No metadata keyword match; inspect imagery before use");
  if (candidate.mediaType === "video") {
    score += 10;
    reasons.push("Motion candidate, not a confirmed visual match");
    if (Number.isFinite(candidate.durationSeconds) && candidate.durationSeconds >= 4) {
      score += candidate.durationSeconds >= 12 ? 12 : 7;
      reasons.push("Source duration known; narration timeline still unverified");
    } else reasons.push("Clip duration missing or short");
  } else reasons.push("Still media; not a moving-video background");
  if (Number.isInteger(candidate.width) && Number.isInteger(candidate.height)) {
    if (candidate.width >= 1920 && candidate.height >= 1080) {
      score += 15;
      reasons.push("At least Full HD source resolution");
    } else if (candidate.width >= 1280 && candidate.height >= 720) {
      score += 10;
      reasons.push("At least HD source resolution");
    } else if (candidate.width < 640 || candidate.height < 360) {
      score -= 18;
      reasons.push("Low resolution; cinematic 720p renderer may reject");
    }
  } else reasons.push("Source dimensions unknown");
  if (scene.scienceSourceRequired) {
    if (isScience) {
      score += 14;
      reasons.push("Science-provider candidate; scientific meaning unverified");
    } else {
      score -= 5;
      reasons.push("Stock is contextual B-roll only, not scientific evidence");
    }
  }
  if (candidate.observedDate) reasons.push("Item metadata has date; not independently verified");
  return Object.freeze({
    id: candidate.id,
    candidateId: candidate.id,
    motifId: candidate.motifId,
    sceneId: candidate.sceneId,
    sourcePage: candidate.sourcePage,
    licensePage: candidate.licensePage,
    creator: candidate.creator,
    credit: candidate.credit,
    title: candidate.title,
    description: candidate.description,
    previewUrl: candidate.previewUrl,
    provider: candidate.provider,
    mediaType: candidate.mediaType,
    durationSeconds: candidate.durationSeconds,
    width: candidate.width, height: candidate.height,
    observedDate: candidate.observedDate,
    score: Math.max(0, Math.min(100, score)),
    role, scoreBasis: "PROVIDER_METADATA_ONLY",
    reasons,
    rightsApproved: false, editorialApproved: false,
    thirdPartyRightsCleared: false,
    downloaded: false, selected: false,
    reviewStatus: "HUMAN_CONTENT_AND_LICENSE_REVIEW_REQUIRED",
  });
}

export function rankEpisodeMediaCandidates(library) {
  assert.ok(library && library.schemaVersion === 1 &&
    typeof library.episodeId === "string" &&
    /^[a-z0-9][a-z0-9-]{3,90}$/.test(library.episodeId) &&
    library.rightsStatus === "BLOCKED" &&
    library.publicationAllowed === false &&
    Array.isArray(library.searchPlan) &&
    library.searchPlan.length === 19 &&
    Array.isArray(library.candidates) &&
    library.candidates.length <= 120,
  "Only blocked 19-scene candidate catalogues are eligible for ranking");
  const byScene = new Map();
  for (const scene of library.searchPlan) {
    assert.ok(scene && ID.test(scene.sceneId) &&
      !byScene.has(scene.sceneId) &&
      typeof scene.label === "string" &&
      typeof scene.searchQuery === "string" &&
      typeof scene.scienceSourceRequired === "boolean");
    byScene.set(scene.sceneId, {
      sceneId: scene.sceneId,
      title: scene.label,
      scienceSourceRequired: scene.scienceSourceRequired,
      science: [], broll: [],
    });
  }
  assert.equal(byScene.size, 19);
  const motifs = new Set();
  const counts = new Map();
  for (const original of library.candidates) {
    const known = new Set(byScene.keys());
    const normalized = normalizeSourceCandidate(original, known);
    assert.ok(original.id === normalized.id &&
      original.motifId === normalized.motifId &&
      original.sceneId === normalized.sceneId &&
      original.rightsApproved === false &&
      original.editorialApproved === false &&
      original.thirdPartyRightsCleared === false &&
      original.downloadStatus === "NOT_DOWNLOADED" &&
      original.selection === "ALTERNATIVE",
    "Candidate provenance or unapproved status was changed");
    assert.ok(!motifs.has(normalized.motifId),
      "Repeated motif found in episode candidates");
    motifs.add(normalized.motifId);
    counts.set(normalized.sceneId, (counts.get(normalized.sceneId) ?? 0) + 1);
    assert.ok(counts.get(normalized.sceneId) <= 6,
      "Too many alternatives in one scene");
    const scene = byScene.get(normalized.sceneId);
    const ranked = scoreMediaCandidate({
      sceneId: scene.sceneId, label: scene.title,
      searchQuery: library.searchPlan.find(s => s.sceneId === scene.sceneId).searchQuery,
      scienceSourceRequired: scene.scienceSourceRequired,
    }, normalized);
    (ranked.role === "SCIENTIFIC_SOURCE_REVIEW_REQUIRED" ?
      scene.science : scene.broll).push(ranked);
  }
  const scenes = [...byScene.values()].map(s => {
    s.science.sort(byScore);
    s.broll.sort(byScore);
    const hasScience = s.science.length > 0;
    const hasStock = s.broll.length > 0;
    return Object.freeze({
      ...s,
      status: s.scienceSourceRequired && !hasScience ?
        "MISSING_SCIENCE_SOURCE_CANDIDATES" :
        !hasStock && !hasScience ? "NO_CANDIDATES" : "REVIEW_ALTERNATIVES",
      metadataTopCandidate: (s.scienceSourceRequired ?
        s.science[0] ?? s.broll[0] :
        s.broll[0] ?? s.science[0])?.id ?? null,
    });
  });
  return Object.freeze({
    schemaVersion: 1, episodeId: library.episodeId,
    scoreMeaning: "METADATA_HEURISTIC_NOT_AI_VISUAL_VERIFICATION",
    rightsApproved: false, editorialApproved: false,
    renderAllowed: false, publicationAllowed: false,
    sourceCandidates: motifs.size,
    scenesWithoutCandidates: scenes.filter(s =>
      s.science.length + s.broll.length === 0).length,
    scenesMissingScientificSource: scenes.filter(s =>
      s.scienceSourceRequired && s.science.length === 0).length,
    scenes,
  });
}
