import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {constants as fsConstants} from "node:fs";
import {access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  buildEpisodeAssetResearchPlan, createEpisodeMediaLibrary,
  discoverEpisodeCandidates, normalizePexelsApiResult, normalizeNasaApiResult,
} from "./p3_episode_asset_library.mjs";
import {
  createEpisodeAssetWorkspace, stageReviewedLocalAsset,
  finalizePrivateExportAndCleanup,
} from "./p3_episode_asset_workspace.mjs";

function fixtureStory() {
  const counts = [2, 3, 3, 3, 3, 3, 2];
  const ids = ["intro", "basics", "measurements", "polar", "impact", "future", "outro"];
  return {
    id: "ozone-2026-explained-en", schemaVersion: 1, asOf: "2026-11-09",
    sections: ids.map((id, i) => ({
      id, visuals: Array.from({length: counts[i]}, (_, j) => ({
        kind: "text-card", title: i === 0 && j === 0
          ? "Beautiful night sky" : i === 0 && j === 1
          ? "Polar ozone scientific measurement"
          : "South Pole ozone monitoring " + i + " " + j,
      })),
    })),
  };
}
function nasaFixture(sceneId = "beat-02") {
  const data = {collection: {items: [{
    data: [{nasa_id: "PIA18033", media_type: "image",
      title: "Blue Marble", center: "NASA/JPL", date_created: "2014-01-02T10:00:00Z"}],
    links: [{rel: "preview", href: "https://images-assets.nasa.gov/preview.jpg"}],
  }]}};
  return normalizeNasaApiResult(sceneId, data, 3);
}
function pexelsFixture(sceneId = "beat-01") {
  return normalizePexelsApiResult(sceneId, {
    videos: [{
      id: 987654, url: "https://www.pexels.com/video/example-987654/",
      user: {name: "Photographer"}, duration: 11,
      width: 1920, height: 1080, image: "https://images.pexels.com/preview.jpg",
    }],
  }, "video", 3);
}

test("nineteen scene plans distinguish scientific evidence from generic stock footage", () => {
  const plan = buildEpisodeAssetResearchPlan(fixtureStory());
  assert.equal(plan.scenes.length, 19);
  assert.equal(plan.scenes[0].sceneId, "beat-01");
  assert.equal(plan.scenes[18].sceneId, "beat-19");
  assert.equal(plan.scenes[0].providerPreference[0], "pexels");
  assert.equal(plan.scenes[1].providerPreference[0], "nasa");
  assert.equal(plan.rightsStatus, "BLOCKED");
  assert.equal(plan.scenes[0].desiredAlternatives, 4);
  const candidates = [
    ...pexelsFixture(),
    ...nasaFixture(),
    ...pexelsFixture("beat-04"), // same motif: must never be duplicated elsewhere
  ];
  const lib = createEpisodeMediaLibrary(plan, candidates);
  assert.equal(lib.candidates.length, 2);
  assert.ok(lib.candidates.every(c =>
    c.rightsApproved === false && c.downloadStatus === "NOT_DOWNLOADED"));
  assert.ok(lib.candidates.every(c => c.sourcePage && c.licensePage && c.credit));
  assert.equal(lib.publicationAllowed, false);
  assert.throws(() => createEpisodeMediaLibrary(plan, [{
    ...pexelsFixture()[0], provider: "unknown",
  }]), /Unknown media provider/);
});

test("bounded API metadata discovery never downloads and never auto-approves", async () => {
  const plan = buildEpisodeAssetResearchPlan(fixtureStory());
  const calls = [];
  async function fakeFetch(url, options) {
    calls.push({url, options});
    if (url.startsWith("https://api.pexels.com/"))
      return {ok: true, json: async () => ({videos: [{
        id: 99, url: "https://www.pexels.com/video/stock-99/",
        user: {name: "Source photographer"}, duration: 10,
      }]})};
    return {ok: true, json: async () => ({
      collection: {items: [{
        data: [{nasa_id: "ABC123", media_type: "video", title: "Science visualization"}],
      }]},
    })};
  }
  const result = await discoverEpisodeCandidates(plan, {
    fetchImpl: fakeFetch, pexelsKey: "FAKE_NOT_REAL", maxQueries: 2,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/api\.pexels\.com\/v1\/videos\/search/);
  assert.equal(calls[0].options.headers.Authorization, "FAKE_NOT_REAL");
  assert.match(calls[1].url, /^https:\/\/images-api\.nasa\.gov\/search/);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(result.notQueried, 17);
  assert.equal(result.library.candidates.length, 2);
  assert.equal(result.library.rightsStatus, "BLOCKED");
  assert.match(result.status, /NO_DOWNLOADS_NO_RIGHTS_APPROVAL/);
  await assert.rejects(() => discoverEpisodeCandidates(plan, {
    fetchImpl: fakeFetch, maxQueries: 50,
  }), /assert/i);
});

test("private cache is purged only after verified export and durable provenance receipt", async () => {
  const base = await mkdtemp(join(tmpdir(), "vns-p3-10-"));
  const root = join(base, "private-cache");
  const receipts = join(base, "receipts");
  try {
    await mkdir(root, {mode: 0o700});
    await mkdir(receipts, {mode: 0o700});
    const workspace = await createEpisodeAssetWorkspace({
      root, episodeId: "ozone-2026-explained-en",
    });
    const original = join(base, "reviewed-image.png");
    const raw = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(90, 7),
    ]);
    await writeFile(original, raw);
    const sha = createHash("sha256").update(raw).digest("hex");
    const reviewed = {
      rightsApproved: true, editorialApproved: true,
      thirdPartyRightsCleared: true, sha256: sha,
      sourcePage: "https://images.nasa.gov/details/PIA18033",
      licensePage: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
      licenseEvidence: "Human reviewed on source page; private test fixture",
      reviewedBy: "test-reviewer", sceneId: "beat-03", provider: "nasa",
    };
    await assert.rejects(
      () => stageReviewedLocalAsset({
        workspace, sourcePath: original,
        reviewed: {...reviewed, rightsApproved: false},
      }), /explicit individual review approvals/);
    const staged = await stageReviewedLocalAsset({
      workspace, sourcePath: original, reviewed,
    });
    assert.equal(staged.sha256, sha);
    assert.deepEqual(await readFile(staged.localPath), raw);
    await assert.rejects(() => stageReviewedLocalAsset({
      workspace, sourcePath: original, reviewed,
    }), /EEXIST/);

    const story = fixtureStory();
    const lib = createEpisodeMediaLibrary(buildEpisodeAssetResearchPlan(story),
      [...nasaFixture()]);
    lib.mediaFiles.push(staged);
    const mp4 = join(base, "final-private-review.mp4");
    const output = Buffer.concat([Buffer.alloc(4), Buffer.from("ftyp"),
      Buffer.alloc(1500, 4)]);
    await writeFile(mp4, output);
    const exportSha = createHash("sha256").update(output).digest("hex");
    const receipt = join(receipts, "ozone-2026-asset-provenance.json");
    const opts = {
      workspace, root, library: lib,
      privateExportPath: mp4, expectedExportSha256: exportSha,
      receiptPath: receipt, explicitCleanupApproved: true,
    };
    await assert.rejects(
      () => finalizePrivateExportAndCleanup({
        ...opts, expectedExportSha256: "0".repeat(64),
      }), /Export checksum mismatch/);
    assert.ok((await stat(staged.localPath)).isFile(),
      "Wrong MP4 SHA must not destroy media");
    await assert.rejects(
      () => finalizePrivateExportAndCleanup({
        ...opts, explicitCleanupApproved: false,
      }), /explicit approval/);
    assert.ok((await stat(staged.localPath)).isFile());
    const result = await finalizePrivateExportAndCleanup(opts);
    assert.equal(result.status, "PRIVATE_EXPORT_VERIFIED_CACHE_PURGED");
    await assert.rejects(() => access(workspace, fsConstants.F_OK), /ENOENT/);
    const retained = JSON.parse(await readFile(receipt, "utf8"));
    assert.equal(retained.export.sha256, exportSha);
    assert.equal(retained.candidates.length, 1);
    assert.equal(retained.stagedAssets[0].sha256, sha);
    assert.equal(retained.publicationAllowed, false);
    assert.equal(retained.cachePurged, true);
    assert.ok((await stat(mp4)).isFile(), "Private exported video is preserved");

    const maliciousRoot = join(base, "link-root");
    await symlink(root, maliciousRoot);
    await assert.rejects(() => createEpisodeAssetWorkspace({
      root: maliciousRoot, episodeId: "ozone-2026-explained-en",
    }), /non-symlink/);
  } finally {
    await rm(base, {recursive: true, force: true});
  }
});
