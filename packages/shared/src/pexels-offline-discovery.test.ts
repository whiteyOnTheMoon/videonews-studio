import assert from "node:assert/strict";
import test from "node:test";
import { precheckAssetLicense } from "./asset-license-policy.js";
import { readOfflinePexelsPage } from "./pexels-offline-discovery.js";

const PHOTO = {
  id: 111001,
  url: "https://www.pexels.com/photo/synthetic-landscape-111001/",
  photographer: "Synthetic Contributor",
  photographer_url: "https://www.pexels.com/@synthetic-contributor/",
  src: {
    original: "https://images.pexels.com/photos/111001/pexels-photo-111001.jpeg",
  },
  alt: "A hypothetical scene; not actual external media",
};

const VIDEO = {
  id: 222002,
  url: "https://www.pexels.com/video/222002/",
  image: "https://images.pexels.com/videos/222002/free-video-222002.jpg?fit=crop&w=1200",
  duration: 22,
  user: {
    id: 333003,
    name: "Synthetic Videographer",
    url: "https://www.pexels.com/@synthetic-videographer",
  },
  video_files: [
    {
      quality: "hd",
      file_type: "video/mp4",
      link: "https://player.vimeo.com/external/not-an-actual-file.mp4",
    },
  ],
};

test("photo API-shaped metadata is sanitized to a deny-only candidate", () => {
  const result = readOfflinePexelsPage(
    { page: 1, per_page: 2, photos: [PHOTO], Authorization: "secret-to-ignore" },
    "photo",
  );
  assert.equal(result.status, "BLOCKED_CANDIDATES");
  assert.equal(result.renderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  if (result.status !== "BLOCKED_CANDIDATES") return;
  const candidate = result.candidates[0]!;
  assert.equal(candidate.provider, "pexels");
  assert.equal(candidate.providerId, "111001");
  assert.equal(candidate.kind, "image");
  assert.equal(candidate.creator, "Synthetic Contributor");
  assert.equal(candidate.originUrl, PHOTO.url);
  assert.equal(candidate.rightsStatus, "blocked");
  assert.equal(candidate.licenseCode, "PEXELS-CUSTOM");
  assert.equal(candidate.licenseUrl, "https://www.pexels.com/license/");
  assert.equal(candidate.mediaDownloaded, false);
  assert.equal(candidate.contentSha256, null);
  assert.equal(candidate.licenseSnapshot, null);
  assert.equal(candidate.cacheTtlSeconds, 86400);
  assert.deepEqual(candidate.rightsFlags, {
    identifiablePeople: "unknown",
    visibleTrademarks: "unknown",
    thirdPartyProperty: "unknown",
    editorialOnly: "unknown",
  });
  assert.ok(candidate.attribution.includes("Synthetic Contributor"));
  assert.ok(candidate.providerAttribution.includes("https://www.pexels.com/"));
  assert.equal(precheckAssetLicense(candidate).status, "BLOCKED");
  const exported = JSON.stringify(result);
  assert.ok(!exported.includes("secret-to-ignore"));
  assert.ok(!exported.includes("images.pexels.com"));
  assert.ok(!exported.includes("player.vimeo.com"));
});

test("official video preview query is accepted but actual clip URL is not exposed", () => {
  const result = readOfflinePexelsPage({ page: 1, per_page: 1, videos: [VIDEO] }, "video");
  assert.equal(result.status, "BLOCKED_CANDIDATES");
  assert.equal(result.renderAllowed, false);
  if (result.status !== "BLOCKED_CANDIDATES") return;
  assert.equal(result.candidates[0]!.providerId, "222002");
  assert.equal(result.candidates[0]!.kind, "video");
  assert.equal(result.candidates[0]!.creator, "Synthetic Videographer");
  assert.ok(result.candidates[0]!.attribution.includes("Video by"));
  assert.ok(!JSON.stringify(result).includes("player.vimeo.com"));
  assert.ok(!JSON.stringify(result).includes("images.pexels.com"));
  assert.equal(precheckAssetLicense(result.candidates[0]).status, "BLOCKED");
});

test("missing or mismatched origin IDs and spoofed hostnames fail closed", () => {
  for (const override of [
    { url: "https://www.pexels.com/photo/synthetic-landscape-999/" },
    { url: "https://www.pexels.com.evil.invalid/photo/synthetic-landscape-111001/" },
    { url: "http://www.pexels.com/photo/synthetic-landscape-111001/" },
    { url: "https://www.pexels.com:8443/photo/synthetic-landscape-111001/" },
    { url: "https://www.pexels.com@evil.invalid/photo/synthetic-landscape-111001/" },
    { url: "https://www.pexels.com/photo/synthetic-landscape-111001/#changed" },
    { url: "https://www.pexels.com/photo/synthetic-landscape-111001/?download=yes" },
    { url: "https://www.pexels.com/photo/%2e%2e/111001/" },
  ]) {
    const result = readOfflinePexelsPage(
      { page: 1, per_page: 1, photos: [{ ...PHOTO, ...override }] },
      "photo",
    );
    assert.equal(result.status, "REJECTED", JSON.stringify(override));
    assert.equal(result.candidates.length, 0);
    assert.equal(result.renderAllowed, false);
  }
});

test("creator, profile, and media preview must match expected resource identity", () => {
  for (const override of [
    { photographer: " " },
    { photographer: "<img src=x onerror=alert(1)>" },
    { photographer: "Actor\nUnknown" },
    { photographer_url: "https://evil.invalid/@synthetic-contributor" },
    { photographer_url: "https://www.pexels.com/@synthetic-contributor#other" },
    { src: { original: "https://images.pexels.com/photos/111002/file.jpeg" } },
    { src: { original: "https://evil.invalid/photos/111001/file.jpeg" } },
    { src: {} },
    { id: 0 },
    { id: 1.5 },
    { id: "111001" },
  ]) {
    const result = readOfflinePexelsPage(
      { page: 1, per_page: 1, photos: [{ ...PHOTO, ...override }] },
      "photo",
    );
    assert.equal(result.status, "REJECTED", JSON.stringify(override));
    assert.equal(result.candidates.length, 0);
  }
});

test("video source, creator, and screenshot are required; media URL is never returned", () => {
  for (const override of [
    { url: "https://www.pexels.com/video/222003/" },
    { url: "https://www.pexels.com/photo/test-222002/" },
    { user: null },
    { user: { name: "Synthetic Videographer", url: "https://example.invalid" } },
    { user: { name: "<script>bad</script>", url: "https://www.pexels.com/@synthetic" } },
    { image: "https://images.pexels.com/videos/222003/free-video.jpg" },
    { image: "http://images.pexels.com/videos/222002/free-video.jpg" },
    { image: "https://images.pexels.com/videos/222002/free-video.jpg#fragment" },
  ]) {
    const result = readOfflinePexelsPage(
      { page: 1, per_page: 1, videos: [{ ...VIDEO, ...override }] },
      "video",
    );
    assert.equal(result.status, "REJECTED", JSON.stringify(override));
    assert.equal(result.candidates.length, 0);
  }
});

test("duplicate assets, malformed pages, and wrong media kinds reject atomically", () => {
  for (const [raw, kind] of [
    [null, "photo"],
    [{ photos: [PHOTO] }, "photo"],
    [{ page: 0, per_page: 1, photos: [PHOTO] }, "photo"],
    [{ page: 1, per_page: 81, photos: [PHOTO] }, "photo"],
    [{ page: 1, per_page: 1, photos: [] }, "photo"],
    [{ page: 1, per_page: 1, videos: [VIDEO] }, "photo"],
    [{ page: 1, per_page: 1, photos: [PHOTO, PHOTO] }, "photo"],
    [{ page: 1, per_page: 2, photos: [PHOTO, { ...PHOTO, id: 0 }] }, "photo"],
    [{ page: 1, per_page: 1, photos: [PHOTO] }, "unknown"],
  ] as const) {
    const result = readOfflinePexelsPage(raw, kind as "photo");
    assert.equal(result.status, "REJECTED", JSON.stringify(raw));
    assert.equal(result.candidates.length, 0);
    assert.equal(result.renderAllowed, false);
    assert.equal(result.uploadAllowed, false);
  }
});
