#!/usr/bin/env node
/**
 * P3-10: offline episode-scoped asset-research plans and source catalogues.
 * Discovery is NOT a license grant. No remote downloads or publication.
 */
import assert from "node:assert/strict";

const SCENE_ID = /^beat-(0[1-9]|1[0-9])$/;
const PROVIDERS = new Set(["nasa", "pexels", "unsplash", "pixabay"]);
const MEDIA = new Set(["photo", "video", "animation", "illustration"]);
const SCIENCE = /\b(ozone|nasa|noaa|antarct|pole|polar|vortex|measur|stratospher|atmospher|recovery|data|satellite|uv|climate)\b/i;

function httpsUrl(raw) {
  if (typeof raw !== "string") return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !!url.hostname &&
      !url.username && !url.password;
  } catch { return false; }
}
function text(raw, max = 180) {
  return typeof raw === "string" ? raw.trim().slice(0, max) : "";
}
function strictWordQuery(raw) {
  const words = text(raw, 160).replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/).filter(Boolean);
  return words.slice(0, 8).join(" ");
}

export function buildEpisodeAssetResearchPlan(story) {
  assert.ok(story && story.schemaVersion === 1 &&
    /^[a-z0-9][a-z0-9-]{3,90}$/.test(story.id));
  assert.ok(Array.isArray(story.sections) && story.sections.length >= 1 &&
    story.sections.length <= 14);
  const scenes = [];
  for (const section of story.sections) {
    assert.ok(typeof section.id === "string" &&
      Array.isArray(section.visuals) && section.visuals.length <= 8);
    for (const visual of section.visuals) {
      assert.ok(visual && typeof visual.title === "string");
      const idx = scenes.length + 1;
      assert.ok(idx <= 19, "At most 19 P3 story beats");
      const title = text(visual.title, 96);
      assert.ok(title.length >= 3);
      const science = SCIENCE.test(title) || SCIENCE.test(section.id);
      const searchQuery = strictWordQuery(title);
      assert.ok(searchQuery.length >= 3);
      scenes.push(Object.freeze({
        sceneId: "beat-" + String(idx).padStart(2, "0"),
        sectionId: section.id,
        label: title, purpose: science ? "scientific-evidence" : "contextual-b-roll",
        scienceSourceRequired: science,
        searchQuery: science
          ? searchQuery + " NASA scientific visualization"
          : searchQuery + " documentary b roll",
        providerPreference: science
          ? ["nasa", "pexels"]
          : ["pexels", "nasa"],
        desiredAlternatives: 4,
        maximumDownloads: 2,
      }));
    }
  }
  assert.equal(scenes.length, 19, "P3 video expects 19 visual beats");
  return Object.freeze({
    schemaVersion: 1,
    episodeId: story.id,
    sourceStoryAsOf: text(story.asOf, 32),
    purpose: "temporary-asset-research",
    downloadPolicy: "reviewed-selection-only",
    rightsStatus: "BLOCKED",
    scenes,
  });
}

export function normalizeSourceCandidate(raw, allowedSceneIds) {
  assert.ok(raw && typeof raw === "object");
  const provider = text(raw.provider, 24).toLowerCase();
  assert.ok(PROVIDERS.has(provider), "Unknown media provider");
  const sceneId = text(raw.sceneId, 12);
  assert.ok(SCENE_ID.test(sceneId) && allowedSceneIds.has(sceneId),
    "Invalid candidate scene");
  const providerId = text(String(raw.providerId ?? ""), 110);
  assert.ok(/^[a-zA-Z0-9._:-]{1,110}$/.test(providerId),
    "Candidate needs a stable provider asset ID");
  const mediaType = text(raw.mediaType, 20).toLowerCase();
  assert.ok(MEDIA.has(mediaType));
  assert.ok(httpsUrl(raw.sourcePage), "Missing source page");
  assert.ok(httpsUrl(raw.licensePage), "Missing license reference");
  const creator = text(raw.creator, 120);
  const credit = text(raw.credit, 200);
  assert.ok(creator && credit, "Source creator and credit are mandatory");
  const motifId = provider + ":" + providerId;
  return Object.freeze({
    id: motifId,
    sceneId, provider, providerId, motifId, mediaType,
    title: text(raw.title, 140),
    sourcePage: raw.sourcePage, licensePage: raw.licensePage,
    creator, credit,
    description: text(raw.description, 400),
    observedDate: text(raw.observedDate, 32) || null,
    previewUrl: httpsUrl(raw.previewUrl) ? raw.previewUrl : null,
    durationSeconds: Number.isFinite(raw.durationSeconds)
      ? Math.max(0, raw.durationSeconds) : null,
    width: Number.isSafeInteger(raw.width) ? raw.width : null,
    height: Number.isSafeInteger(raw.height) ? raw.height : null,
    downloadStatus: "NOT_DOWNLOADED",
    reviewStatus: "NEEDS_SOURCE_AND_RIGHTS_REVIEW",
    rightsApproved: false, editorialApproved: false,
    thirdPartyRightsCleared: false,
    selection: "ALTERNATIVE",
  });
}

export function createEpisodeMediaLibrary(plan, candidates = []) {
  assert.ok(plan && plan.schemaVersion === 1 && Array.isArray(plan.scenes));
  const sceneIds = new Set(plan.scenes.map(s => s.sceneId));
  assert.equal(sceneIds.size, plan.scenes.length);
  assert.ok(Array.isArray(candidates) && candidates.length <= 120);
  const seen = new Set(), catalog = [];
  const counts = new Map(plan.scenes.map(s => [s.sceneId, 0]));
  for (const candidate of candidates) {
    const item = normalizeSourceCandidate(candidate, sceneIds);
    // One photograph/video is not offered repeatedly across scenes.
    if (seen.has(item.motifId)) continue;
    if (counts.get(item.sceneId) >= 6) continue;
    seen.add(item.motifId);
    counts.set(item.sceneId, counts.get(item.sceneId) + 1);
    catalog.push(item);
  }
  return {
    schemaVersion: 1,
    episodeId: plan.episodeId,
    sourceStoryAsOf: plan.sourceStoryAsOf,
    rightsStatus: "BLOCKED",
    publicationAllowed: false,
    searchPlan: plan.scenes,
    candidates: catalog,
    mediaFiles: [],
    exportReceipt: null,
  };
}

function dateCreated(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10) : null;
}

export function normalizeNasaApiResult(sceneId, data, max = 5) {
  const items = data?.collection?.items;
  assert.ok(Array.isArray(items), "NASA API must return a collection.items array");
  const results = [];
  for (const item of items.slice(0, 20)) {
    const meta = item.data?.[0];
    if (!meta || !/^[a-zA-Z0-9._-]+$/.test(meta.nasa_id ?? "")) continue;
    const mediaType = meta.media_type === "video" ? "video" :
      meta.media_type === "image" ? "photo" : null;
    if (!mediaType) continue;
    const preview = item.links?.find(link => link.rel === "preview")?.href ??
      item.links?.[0]?.href;
    results.push({
      sceneId, provider: "nasa", providerId: meta.nasa_id,
      mediaType, title: meta.title ?? "NASA science media",
      sourcePage: "https://images.nasa.gov/details/" + encodeURIComponent(meta.nasa_id),
      licensePage: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
      creator: meta.photographer ?? meta.secondary_creator ?? "NASA",
      credit: "NASA / " + (meta.photographer ?? meta.center ?? "media archive"),
      description: meta.description ?? "",
      observedDate: dateCreated(meta.date_created),
      previewUrl: preview,
    });
    if (results.length >= max) break;
  }
  return results;
}

export function normalizePexelsApiResult(sceneId, data, mediaType, max = 5) {
  assert.ok(mediaType === "photo" || mediaType === "video");
  const list = mediaType === "photo" ? data?.photos : data?.videos;
  assert.ok(Array.isArray(list), "Pexels API response does not contain expected items");
  return list.slice(0, max).filter(item =>
    Number.isSafeInteger(item?.id) && httpsUrl(item?.url)).map(item => ({
    sceneId, provider: "pexels", providerId: String(item.id),
    mediaType, title: item.alt ?? item.url,
    sourcePage: item.url,
    licensePage: "https://www.pexels.com/license/",
    creator: mediaType === "photo" ? item.photographer ?? "Pexels contributor" :
      item.user?.name ?? "Pexels contributor",
    credit: "Source: " + (mediaType === "photo" ?
      item.photographer ?? "Pexels contributor" :
      item.user?.name ?? "Pexels contributor") + " / Pexels",
    description: item.alt ?? "",
    previewUrl: mediaType === "photo" ? item.src?.medium : item.image,
    durationSeconds: mediaType === "video" ? item.duration : null,
    width: item.width, height: item.height,
  }));
}

/**
 * API discovery is bounded, opt-in and metadata-only. No mass downloads.
 * NASA needs no key. Pexels is used only with an existing operator-supplied
 * API key; keys must never be serialized into the library.
 * Unsplash and Pixabay are manual candidates pending compliant workflows.
 */
export async function discoverEpisodeCandidates(plan, {
  fetchImpl = fetch, pexelsKey = null, maxQueries = 4,
} = {}) {
  assert.ok(plan && Array.isArray(plan.scenes));
  assert.ok(Number.isSafeInteger(maxQueries) && maxQueries >= 1 && maxQueries <= 6);
  const results = [], log = [];
  let used = 0;
  for (const scene of plan.scenes) {
    if (used >= maxQueries) break;
    const provider = scene.scienceSourceRequired || !pexelsKey ? "nasa" : "pexels";
    const endpoint = provider === "nasa" ?
      "https://images-api.nasa.gov/search" :
      "https://api.pexels.com/v1/videos/search";
    const url = new URL(endpoint);
    url.searchParams.set("q", scene.searchQuery);
    if (provider === "nasa") {
      url.searchParams.set("media_type", "image,video");
      url.searchParams.set("page_size", "6");
    } else {
      url.searchParams.set("per_page", "6");
      url.searchParams.set("orientation", "landscape");
    }
    used += 1;
    const response = await fetchImpl(url.href, {
      headers: provider === "pexels" ?
        {Authorization: pexelsKey, Accept: "application/json"} :
        {Accept: "application/json"},
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      log.push({sceneId: scene.sceneId, provider, status: "HTTP_" + response.status});
      continue;
    }
    const body = await response.json();
    const candidates = provider === "nasa"
      ? normalizeNasaApiResult(scene.sceneId, body, 5)
      : normalizePexelsApiResult(scene.sceneId, body, "video", 5);
    results.push(...candidates);
    log.push({sceneId: scene.sceneId, provider, status: "OK",
      candidates: candidates.length});
  }
  return {
    library: createEpisodeMediaLibrary(plan, results),
    queryLog: log,
    queriedScenes: used,
    notQueried: plan.scenes.length - used,
    status: "RESEARCH_ONLY_NO_DOWNLOADS_NO_RIGHTS_APPROVAL",
  };
}
