#!/usr/bin/env node
/**
 * P3-11: explicit handoff from curated story and research evidence to visual
 * discovery. The research worker itself only stores unreviewed candidates.
 * This is an independent opt-in stage: NO downloads, asset approvals, or publishing.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {
  buildEpisodeAssetResearchPlan,
  createEpisodeMediaLibrary,
  normalizeNasaApiResult,
  normalizePexelsApiResult,
} from "./p3_episode_asset_library.mjs";

const HEX = /^[a-f0-9]{64}$/;
const REVIEWER = /^[a-zA-Z0-9._-]{3,90}$/;
const MAX_RESPONSE = 512 * 1024;
const BUDGET_MAX = 4;
const SCIENCE_API = "https://images-api.nasa.gov/search";
const STOCK_API = "https://api.pexels.com/v1/videos/search";

function isHttps(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".") &&
      !url.username && !url.password && !url.hash && !url.port;
  } catch {return false;}
}
function digestStory(story) {
  return createHash("sha256").update(JSON.stringify(story)).digest("hex");
}
export function verifyPostEditorialMediaHandoff({story, researchReport, attestation}) {
  assert.ok(story && story.schemaVersion === 1 &&
    story.editorialApproved === false &&
    story.publicationAllowed === false &&
    story.renderAllowed === false && story.uploadAllowed === false,
  "Curated preview story must keep all publication and render gates denied");
  assert.ok(Array.isArray(story.sources) && story.sources.length >= 2 &&
    story.sources.length <= 30 &&
    story.sources.every(s => isHttps(s.url) && typeof s.id === "string"),
  "Curated story source provenance invalid");
  assert.ok(researchReport && researchReport.version === 1 &&
    HEX.test(researchReport.eventId) &&
    researchReport.approvedForPublication === false &&
    Array.isArray(researchReport.sourceUrls) &&
    researchReport.sourceUrls.length >= 1 &&
    researchReport.sourceUrls.length <= 30 &&
    researchReport.sourceUrls.every(isHttps) &&
    Array.isArray(researchReport.decisions) &&
    researchReport.decisions.includes("offline_metadata_only"),
  "Research report must remain a candidate-only offline evidence report");
  const storySources = new Set(story.sources.map(s => s.url));
  const overlap = [...new Set(researchReport.sourceUrls)].filter(url => storySources.has(url));
  assert.ok(overlap.length >= 1,
    "No matching source URL between candidate research and curated story");
  assert.ok(attestation && attestation.kind === "post-editorial-media-research-only" &&
    attestation.reviewedStoryId === story.id &&
    attestation.storySha256 === digestStory(story) &&
    attestation.researchEventId === researchReport.eventId &&
    REVIEWER.test(attestation.reviewerId) &&
    attestation.sourceLinkReviewed === true &&
    attestation.allowMetadataResearch === true &&
    attestation.allowMediaDownloads === false &&
    attestation.allowPublication === false &&
    typeof attestation.reviewedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(attestation.reviewedAt) &&
    Number.isFinite(Date.parse(attestation.reviewedAt)),
  "A named review bound to this exact story and research event is required");
  const plan = buildEpisodeAssetResearchPlan(story);
  return {
    plan,
    receipt: {
      schemaVersion: 1, episodeId: story.id,
      curatedStorySha256: attestation.storySha256,
      researchEventId: researchReport.eventId,
      reviewedBy: attestation.reviewerId,
      reviewedAt: attestation.reviewedAt,
      matchingEvidenceSourceUrls: overlap,
      pendingOriginalSourceCount: story.sources.length - overlap.length,
      status: "METADATA_RESEARCH_ONLY_NO_MEDIA_APPROVAL",
      rightsApproved: false, renderAllowed: false, publicationAllowed: false,
    },
  };
}

function contextQuery(label) {
  const lower = label.toLowerCase();
  if (/polar|antarct|ice|vortex/.test(lower)) return "antarctic landscape ice aerial";
  if (/earth|atmospher|uv|ozone/.test(lower)) return "earth atmosphere space cinematic";
  if (/measure|scientist|data|monitor|laboratory/.test(lower))
    return "scientist satellite laboratory monitoring";
  return "environmental science documentary nature";
}
export function buildVisualResearchTasks(plan) {
  assert.ok(plan && Array.isArray(plan.scenes) && plan.scenes.length === 19);
  const ids = new Set();
  const tasks = [];
  for (const scene of plan.scenes) {
    assert.ok(scene && /^beat-(0[1-9]|1[0-9])$/.test(scene.sceneId) &&
      !ids.has(scene.sceneId));
    ids.add(scene.sceneId);
    // Stock content never replaces scientific evidence, and scientific media
    // is searched independently rather than by a general stock query.
    if (scene.scienceSourceRequired) tasks.push(Object.freeze({
      id: scene.sceneId + ":nasa",
      sceneId: scene.sceneId, provider: "nasa",
      query: scene.searchQuery.slice(0, 150), role: "SCIENCE_CANDIDATE_UNVERIFIED",
    }));
    tasks.push(Object.freeze({
      id: scene.sceneId + ":pexels",
      sceneId: scene.sceneId, provider: "pexels",
      query: contextQuery(scene.label), role: "CONTEXT_ONLY_NOT_EVIDENCE",
    }));
  }
  return Object.freeze(tasks);
}

function boundedBody(raw, provider) {
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw),
    provider + " API returned invalid JSON");
  return raw;
}

/**
 * At most 4 metadata-only, fixed-host API calls per invocation.
 * Missing Pexels key skips (not retries) the stock task; providers do not
 * silently substitute NASA science media for background-only footage.
 */
export async function researchVisualBatch({
  plan, tasks, cursor = 0, budget = BUDGET_MAX, previous = null,
  pexelsKey = null, fetchImpl = fetch,
}) {
  assert.ok(plan && Array.isArray(plan.scenes) && plan.scenes.length === 19);
  const expected = buildVisualResearchTasks(plan);
  assert.ok(Array.isArray(tasks) && tasks.length === expected.length &&
    tasks.every((task, i) =>
      task.id === expected[i].id &&
      task.sceneId === expected[i].sceneId &&
      task.provider === expected[i].provider &&
      task.role === expected[i].role &&
      task.query === expected[i].query),
  "Research task schedule must match this immutable story plan");
  assert.ok(Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= tasks.length);
  assert.ok(Number.isSafeInteger(budget) && budget >= 1 && budget <= BUDGET_MAX);
  assert.ok(pexelsKey === null || (typeof pexelsKey === "string" &&
    pexelsKey.length >= 5 && pexelsKey.length < 200));
  const old = previous?.candidates ?? [];
  if (previous) {
    assert.ok(previous.schemaVersion === 1 &&
      previous.episodeId === plan.episodeId &&
      previous.publicationAllowed === false &&
      Array.isArray(previous.candidates),
    "Cannot resume discovery with another episode's catalogue");
    assert.ok(old.every(item => item && item.rightsApproved === false &&
      item.editorialApproved === false && item.thirdPartyRightsCleared === false &&
      item.downloadStatus === "NOT_DOWNLOADED"),
    "Discovery must never accept already approved or downloaded candidates");
  }
  const found = [], log = [];
  for (const task of tasks.slice(cursor, cursor + budget)) {
    if (task.provider === "pexels" && !pexelsKey) {
      log.push({taskId: task.id, status: "API_KEY_UNAVAILABLE", candidates: 0});
      continue;
    }
    const endpoint = task.provider === "nasa" ? SCIENCE_API : STOCK_API;
    const url = new URL(endpoint);
    url.searchParams.set(task.provider === "nasa" ? "q" : "query", task.query);
    if (task.provider === "nasa") {
      url.searchParams.set("media_type", "image,video");
      url.searchParams.set("page_size", "6");
    } else {
      url.searchParams.set("per_page", "6");
      url.searchParams.set("orientation", "landscape");
    }
    try {
      const response = await fetchImpl(url.href, {
        headers: task.provider === "nasa" ?
          {Accept: "application/json"} :
          {Authorization: pexelsKey, Accept: "application/json"},
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        log.push({taskId: task.id, status: "HTTP_" + response.status, candidates: 0});
        continue;
      }
      const reported = Number(response.headers?.get?.("content-length") ?? 0);
      if (reported > MAX_RESPONSE) throw new Error("Provider metadata too large");
      // Support injected CI providers with the same text response shape.
      const body = await response.text();
      if (body.length > MAX_RESPONSE) throw new Error("Provider metadata too large");
      const json = boundedBody(JSON.parse(body), task.provider);
      const normalized = task.provider === "nasa" ?
        normalizeNasaApiResult(task.sceneId, json, 5) :
        normalizePexelsApiResult(task.sceneId, json, "video", 5);
      found.push(...normalized);
      log.push({taskId: task.id, status: "METADATA_ONLY", candidates: normalized.length});
    } catch {
      // Never log response bodies, URLs with credentials or provider stack traces.
      log.push({taskId: task.id, status: "PROVIDER_FETCH_REFUSED", candidates: 0});
    }
  }
  const library = createEpisodeMediaLibrary(plan, [...old, ...found]);
  library.candidates = library.candidates.map(item => ({
    ...item,
    visualRole: item.provider === "nasa" ?
      "SCIENTIFIC_SOURCE_REVIEW_REQUIRED" : "CONTEXT_ONLY_NOT_EVIDENCE",
  }));
  const nextCursor = Math.min(tasks.length, cursor + budget);
  const covered = new Set(library.candidates.map(item => item.sceneId));
  return {
    status: "POST_EDITORIAL_METADATA_DISCOVERY_NO_DOWNLOADS",
    library, nextCursor, complete: nextCursor === tasks.length,
    queriesAttempted: log.filter(i => i.status !== "API_KEY_UNAVAILABLE").length,
    scenesWithCandidates: covered.size,
    scenesWithoutCandidates: 19 - covered.size,
    queryLog: log,
    publicationAllowed: false, rightsApproved: false,
  };
}
