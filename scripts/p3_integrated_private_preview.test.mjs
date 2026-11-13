import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  access, mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  buildEpisodeAssetResearchPlan, createEpisodeMediaLibrary,
} from "./p3_episode_asset_library.mjs";
import {createEpisodeAssetWorkspace, finalizePrivateExportAndCleanup} from
  "./p3_episode_asset_workspace.mjs";
import {buildOfflineMediaBoard} from "./p3_media_review_board.mjs";
import {
  planQuarantineDownloads, acquireQuarantinedMedia,
  buildReviewedPrivateClipManifest,
} from "./p3_reviewed_media_selection.mjs";
import {
  planCinematicTimeline, encodeCinematicSpan, encodeGraphicTail,
} from "./p3_cinematic_timeline.mjs";

const FPS = 24;
const SHA = b => createHash("sha256").update(b).digest("hex");
function run(name, args, seconds = 90) {
  const r = spawnSync(name, args, {
    encoding: "utf8", timeout: seconds * 1000, maxBuffer: 512 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(r.status, 0, name + ": " +
    (r.stderr ?? "").slice(-1000) + " / " + (r.error?.message ?? ""));
  return r.stdout;
}
function probe(path) {
  return JSON.parse(run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,nb_frames,width,height",
    "-of", "json", path,
  ]));
}
function syntheticStory() {
  const group = ["hook", "basics", "measurements", "polar-vortex",
    "impact", "whats-next", "takeaway"];
  const sizes = [2, 3, 3, 3, 3, 3, 2];
  return {
    schemaVersion: 1, id: "ozone-2026-ci-private-explainer",
    asOf: "2026-11-13", sources: [],
    sections: group.map((sectionId, i) => ({
      id: sectionId,
      visuals: Array.from({length: sizes[i]}, (_, j) => ({
        kind: "text-card",
        title: "Synthetic ozone explanation " + i + "-" + j,
        body: "This synthetic fixture illustrates an offline timeline only.",
      })),
    })),
  };
}
function fixtures(story) {
  const plan = buildEpisodeAssetResearchPlan(story);
  const candidate = (sceneId, provider, providerId) => ({
    sceneId, provider, providerId, mediaType: "video",
    title: "Synthetic science animation for offline testing",
    description: "Video generated with local FFmpeg, not actual NASA or Pexels media",
    sourcePage: provider === "nasa" ?
      "https://images.nasa.gov/details/" + providerId :
      "https://www.pexels.com/video/synthetic-test-" + providerId + "/",
    licensePage: provider === "nasa" ?
      "https://www.nasa.gov/nasa-brand-center/images-and-media/" :
      "https://www.pexels.com/license/",
    creator: "CI synthetic fixture",
    credit: "CI synthetic video (not source-provider footage)",
    durationSeconds: provider === "nasa" ? 7 : 5,
    width: 640, height: 360,
  });
  const library = createEpisodeMediaLibrary(plan, [
    candidate("beat-15", "nasa", "CI-FAKE-001"),
    candidate("beat-18", "pexels", "442233"),
  ]);
  return {plan, library};
}
function makeFixtureVideo(path, duration, flip = false) {
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
    "-t", String(duration),
    ...(flip ? ["-vf", "hflip"] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "34",
    "-threads:v", "1", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k", path,
  ], 90);
}
function mockMediaFetch(map) {
  return async (url, request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
    assert.ok(map.has(url), "Unknown fake URL must not be requested");
    const raw = map.get(url);
    return {
      status: 200,
      headers: {get: key => key === "content-length" ? String(raw.length) :
        key === "content-type" ? "video/mp4" : null},
      body: (async function* () {
        for (let i = 0; i < raw.length; i += 8192) yield raw.subarray(i, i + 8192);
      })(),
    };
  };
}
function namedReview(record, endSceneId, insertFrames) {
  return {
    candidateId: record.candidateId, reviewedFileSha256: record.sha256,
    rightsApproved: true, editorialApproved: true,
    thirdPartyRightsCleared: true,
    rightsReviewedBy: "ci-synthetic-review",
    rightsReviewedAt: "2026-11-13",
    licenseEvidence:
      "CI-generated footage solely for disposable local technical tests; " +
      "no actual NASA, Pexels or third-party footage is licensed or reviewed",
    captureDate: "2026-11-13",
    endSceneId,
    ...(insertFrames === undefined ? {} : {insertFrames}),
  };
}

test("P3-08..14 integrated synthetic private path: selected assets to continuous voiced export and gated cleanup", async () => {
  const base = await mkdtemp(join(tmpdir(), "p3-integrated-"));
  try {
    const cacheRoot = join(base, "episode-cache");
    const receiptRoot = join(base, "source-receipts");
    await mkdir(cacheRoot, {mode: 0o700});
    await mkdir(receiptRoot, {mode: 0o700});
    const story = syntheticStory();
    const {library} = fixtures(story);
    assert.equal(library.searchPlan.length, 19);
    assert.equal(library.candidates.length, 2);
    assert.equal(library.publicationAllowed, false);

    // Provider bytes are locally generated; there are NO external HTTP calls.
    const rawNASA = join(base, "fixture-visual-A.mp4");
    const rawStock = join(base, "fixture-visual-B.mp4");
    makeFixtureVideo(rawNASA, 7);
    makeFixtureVideo(rawStock, 5, true);
    const urlNASA =
      "https://ozonewatch.gsfc.nasa.gov/ozone_maps/movies/ci-synthetic.mp4";
    const urlStock =
      "https://videos.pexels.com/video-files/442233/ci-synthetic.mp4";
    const map = new Map([
      [urlNASA, await readFile(rawNASA)],
      [urlStock, await readFile(rawStock)],
    ]);
    assert.notEqual(SHA(map.get(urlNASA)), SHA(map.get(urlStock)));
    const workspace = await createEpisodeAssetWorkspace({
      root: cacheRoot, episodeId: library.episodeId,
    });
    const selections = [
      {candidateId: "nasa:CI-FAKE-001", sceneId: "beat-15", directUrl: urlNASA},
      {candidateId: "pexels:442233", sceneId: "beat-18", directUrl: urlStock},
    ];
    assert.throws(() => planQuarantineDownloads({
      library, selections, operatorConsent: {
        operatorId: "ci-synthetic-review",
        approvePreviewAcquisition: false,
        allowRendering: false, allowPublication: false,
      },
    }), /Named, explicit download-only consent/);
    const plan = planQuarantineDownloads({
      library, selections, operatorConsent: {
        operatorId: "ci-synthetic-review",
        approvePreviewAcquisition: true,
        allowRendering: false, allowPublication: false,
      },
    });
    const downloaded = await acquireQuarantinedMedia({
      plan, workspace, fetchImpl: mockMediaFetch(map),
    });
    assert.equal(downloaded.files.length, 2);
    assert.equal(downloaded.renderAllowed, false);
    assert.ok(downloaded.files.every(f =>
      f.rightsApproved === false && f.status === "QUARANTINED_REVIEW_REQUIRED"));
    assert.deepEqual(downloaded.files.map(f => f.sha256),
      [SHA(map.get(urlNASA)), SHA(map.get(urlStock))]);
    const receipt = {
      schemaVersion: 1, episodeId: library.episodeId,
      status: "QUARANTINE_ONLY_REQUIRES_REVIEW",
      records: downloaded.files,
    };

    const board = await buildOfflineMediaBoard({
      libraryDocument: library, workspace, receipt,
    });
    assert.equal(board.localPreviews, 2);
    assert.match(board.html, /Bildähnlichkeitsprüfung/);
    assert.match(board.html, /data:image\/jpeg;base64,/);
    assert.match(board.html, /Keine externen Bilder/);
    assert.equal(board.publicationAllowed, false);

    const reviews = [
      namedReview(downloaded.files[0], "beat-15", 96),
      namedReview(downloaded.files[1], "beat-19"),
    ];
    await assert.rejects(() => buildReviewedPrivateClipManifest({
      library, quarantined: downloaded.files,
      reviews: [{...reviews[0], rightsApproved: false}, reviews[1]],
      assetRoot: join(workspace, "quarantine"),
    }), /Reviewer must approve/);
    const approvedForPrivateTest = await buildReviewedPrivateClipManifest({
      library, quarantined: downloaded.files, reviews,
      assetRoot: join(workspace, "quarantine"),
    });
    assert.equal(approvedForPrivateTest.manifest.assets.length, 2);
    assert.equal(approvedForPrivateTest.publicationAllowed, false);

    const beatFrames = Array(19).fill(48);
    beatFrames[14] = 240; // Beat 15: 10 seconds total, 4 seconds motion, 6 of SVG.
    const beatVisuals = story.sections.flatMap(section => section.visuals);
    const photoSlots = Array(19).fill(null);
    for (const i of [0, 2, 7, 8, 10, 12]) photoSlots[i] = i;
    const timeline = await planCinematicTimeline({
      manifest: approvedForPrivateTest.manifest,
      assetRoot: approvedForPrivateTest.manifest.assetRoot,
      beatVisualAssets: photoSlots, beatFrames, beatVisuals,
    });
    assert.equal(timeline.inserts.size, 1);
    assert.equal(timeline.starts.size, 1);
    assert.deepEqual([...timeline.occupied].sort((a, b) => a - b), [14, 17, 18]);
    assert.equal(timeline.inserts.get(14).durationFrames, 96);
    assert.equal(timeline.starts.get(17).durationFrames, 96);
    await assert.rejects(() => planCinematicTimeline({
      manifest: approvedForPrivateTest.manifest,
      assetRoot: approvedForPrivateTest.manifest.assetRoot,
      beatVisualAssets: photoSlots.map((n, i) => i === 14 ? 4 : n),
      beatFrames, beatVisuals,
    }), /photo-backed/);

    const overlays = join(base, "overlay-build");
    const insertVideo = join(base, "insert.mp4");
    await encodeCinematicSpan({
      span: timeline.inserts.get(14), output: insertVideo,
      directory: overlays,
    });
    const svg = join(base, "original.svg"), png = join(base, "original.png");
    await writeFile(svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">' +
      '<rect width="1280" height="720" fill="#071420"/>' +
      '<text x="65" y="320" fill="#ffffff" font-size="40">CI explanatory diagram</text>' +
      '</svg>');
    run("rsvg-convert", ["--output", png, svg]);
    const graphicTail = join(base, "original-graphic-tail.mp4");
    await encodeGraphicTail({imagePath: png, output: graphicTail, frames: 144});
    const continuingVideo = join(base, "two-beat-background.mp4");
    await encodeCinematicSpan({
      span: timeline.starts.get(17), output: continuingVideo,
      directory: overlays,
    });

    const concat = join(base, "segments.ffconcat");
    await writeFile(concat, "ffconcat version 1.0\n" +
      [insertVideo, graphicTail, continuingVideo]
        .map(file => "file '" + file + "'\n").join(""));
    const joined = join(base, "video-only.mp4");
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "concat", "-safe", "0", "-i", concat, "-c:v", "copy", "-an", joined,
    ], 90);
    const joinedInfo = probe(joined);
    assert.equal(joinedInfo.streams.length, 1, "Source audio may not leak");
    assert.equal(joinedInfo.streams[0].codec_name, "h264");
    assert.equal(Number(joinedInfo.streams[0].nb_frames), 336);
    assert.ok(Math.abs(Number(joinedInfo.format.duration) - 14) < 0.12);

    const narration = join(base, "synthetic-voice.wav");
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
      "-t", "14", "-c:a", "pcm_s16le", narration,
    ]);
    const movie = join(base, "private-synthetic-preview.mp4");
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", joined, "-i", narration, "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "96k",
      "-shortest", "-movflags", "+faststart", movie,
    ], 90);
    const final = probe(movie);
    assert.equal(final.streams.length, 2,
      "Exactly one rendered video and one uninterrupted synthetic narration track");
    assert.deepEqual(final.streams.map(s => s.codec_type).sort(),
      ["audio", "video"]);
    assert.equal(final.streams.find(s => s.codec_type === "audio").codec_name, "aac");
    assert.equal(Number(final.streams.find(s => s.codec_type === "video").nb_frames),
      336);
    assert.ok(Math.abs(Number(final.format.duration) - 14) < 0.15);
    assert.ok((await stat(movie)).size > 1024);
    const hash = SHA(await readFile(movie));
    const receiptPath = join(receiptRoot, "synthetic-provenance-receipt.json");
    library.mediaFiles = downloaded.files.map(f => ({
      ...f, reviewedBy: "ci-synthetic-review",
    }));
    const cleanupArgs = {
      workspace, root: cacheRoot, library, privateExportPath: movie,
      expectedExportSha256: hash, receiptPath,
      explicitCleanupApproved: true,
    };
    await assert.rejects(() => finalizePrivateExportAndCleanup({
      ...cleanupArgs, expectedExportSha256: "0".repeat(64),
    }), /Export checksum mismatch/);
    assert.ok((await stat(downloaded.files[0].localPath)).isFile());
    const cleanup = await finalizePrivateExportAndCleanup(cleanupArgs);
    assert.equal(cleanup.status, "PRIVATE_EXPORT_VERIFIED_CACHE_PURGED");
    await assert.rejects(() => access(workspace), /ENOENT/);
    assert.equal((await stat(movie)).isFile(), true);
    const persisted = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(persisted.export.sha256, hash);
    assert.equal(persisted.stagedAssets.length, 2);
    assert.equal(persisted.publicationAllowed, false);
    assert.equal(persisted.cachePurged, true);
  } finally {
    await rm(base, {recursive: true, force: true});
  }
});
