import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  buildEpisodeAssetResearchPlan, createEpisodeMediaLibrary,
} from "./p3_episode_asset_library.mjs";
import {
  acquireQuarantinedMedia, buildReviewedPrivateClipManifest,
  planQuarantineDownloads,
} from "./p3_reviewed_media_selection.mjs";

function sampleLibrary() {
  const sections = Array.from({length: 7}, (_, i) => ({
    id: "science-section-" + i,
    visuals: Array.from({length: [2, 3, 3, 3, 3, 3, 2][i]},
      (_, j) => ({title: "Antarctic ozone test graphic " + i + " " + j})),
  }));
  const plan = buildEpisodeAssetResearchPlan({
    schemaVersion: 1, id: "ozone-2026-explained-en",
    asOf: "2026-11-13", sections,
  });
  const candidate = (sceneId, provider, providerId, type = "video") => ({
    sceneId, provider, providerId, mediaType: type,
    title: "Safe test source", creator: "CI fixture",
    credit: "CI fixture / " + provider,
    sourcePage: provider === "nasa" ?
      "https://images.nasa.gov/details/" + providerId :
      "https://www.pexels.com/video/fixture-" + providerId + "/",
    licensePage: provider === "nasa" ?
      "https://www.nasa.gov/nasa-brand-center/images-and-media/" :
      "https://www.pexels.com/license/",
  });
  return {
    lib: createEpisodeMediaLibrary(plan, [
      candidate("beat-04", "nasa", "SOURCE-01"),
      candidate("beat-04", "nasa", "SOURCE-02"),
      candidate("beat-04", "nasa", "SOURCE-03"),
      candidate("beat-05", "pexels", "91111"),
      candidate("beat-06", "unsplash", "PHOTO-1", "photo"),
    ]),
  };
}
function approval() {
  return {approvePreviewAcquisition: true, operatorId: "qa-operator",
    allowRendering: false, allowPublication: false};
}
const videoUrl = "https://ozonewatch.gsfc.nasa.gov/ozone_maps/movies/fixture.mp4";
const pexelsUrl = "https://videos.pexels.com/video-files/91111/fixture.mp4";
const synthMp4 = Buffer.concat([Buffer.alloc(4),
  Buffer.from("ftyp"), Buffer.from("isom"), Buffer.alloc(100, 7)]);

function pretendResponse(body = synthMp4, {
  type = "video/mp4", length = String(body.length), status = 200,
} = {}) {
  return {
    status, headers: {get: name => name === "content-type" ? type :
      name === "content-length" ? length : null},
    body: (async function* () {
      yield body.subarray(0, 19);
      yield body.subarray(19);
    })(),
  };
}
const selection = (candidateId, sceneId, directUrl) =>
  ({candidateId, sceneId, directUrl});

test("operator sees a bounded set of NASA and Pexels candidates; no other host or stock provider allowed", () => {
  const {lib} = sampleLibrary();
  const plan = planQuarantineDownloads({
    library: lib,
    operatorConsent: approval(),
    selections: [
      selection("nasa:SOURCE-01", "beat-04", videoUrl),
      selection("pexels:91111", "beat-05", pexelsUrl),
    ],
  });
  assert.equal(plan.planned.length, 2);
  assert.equal(plan.rightsApproved, false);
  assert.equal(plan.renderAllowed, false);
  assert.equal(plan.publicationAllowed, false);
  assert.throws(() => planQuarantineDownloads({
    library: lib, operatorConsent: {...approval(), allowRendering: true},
    selections: [selection("nasa:SOURCE-01", "beat-04", videoUrl)],
  }), /Named, explicit/);
  assert.throws(() => planQuarantineDownloads({
    library: lib, operatorConsent: approval(),
    selections: [selection("nasa:SOURCE-01", "beat-05", videoUrl)],
  }), /match episode candidate/);
  assert.throws(() => planQuarantineDownloads({
    library: lib, operatorConsent: approval(),
    selections: [selection("unsplash:PHOTO-1", "beat-06",
      "https://images.unsplash.com/photo-1234.jpg")],
  }), /compliant automatic/);
  assert.throws(() => planQuarantineDownloads({
    library: lib, operatorConsent: approval(),
    selections: [selection("nasa:SOURCE-01", "beat-04",
      "https://evil.example.org/fixture.mp4")],
  }), /approved provider CDN/);
  assert.throws(() => planQuarantineDownloads({
    library: lib, operatorConsent: approval(),
    selections: [selection("nasa:SOURCE-01", "beat-04",
      "https://ozonewatch.gsfc.nasa.gov.attacker.invalid/fixture.mp4")],
  }), /approved provider CDN/);
  assert.throws(() => planQuarantineDownloads({
    library: lib, operatorConsent: approval(),
    selections: [selection("nasa:SOURCE-01", "beat-04", videoUrl + "?token=secret")],
  }), /approved provider CDN/);
  assert.throws(() => planQuarantineDownloads({
    library: lib, operatorConsent: approval(),
    selections: [
      selection("nasa:SOURCE-01", "beat-04", videoUrl),
      selection("nasa:SOURCE-02", "beat-04", videoUrl),
      selection("nasa:SOURCE-03", "beat-04", videoUrl),
    ],
  }), /Maximum two/);
  assert.throws(() => planQuarantineDownloads({
    library: lib, operatorConsent: approval(),
    selections: [
      selection("nasa:SOURCE-01", "beat-04", videoUrl),
      selection("nasa:SOURCE-01", "beat-04", videoUrl),
    ],
  }), /motif may only occur once/);
});

test("fixed-host streaming quarantine caps bytes, rejects dishonest responses, and never authorizes render", async () => {
  const {lib} = sampleLibrary();
  const workspace = await mkdtemp(join(tmpdir(), "p3-reviewed-source-"));
  try {
    const plan = planQuarantineDownloads({
      library: lib, operatorConsent: approval(),
      selections: [selection("nasa:SOURCE-01", "beat-04", videoUrl)],
    });
    let calls = 0;
    const downloaded = await acquireQuarantinedMedia({
      plan, workspace, fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url, videoUrl);
        assert.equal(options.redirect, "error");
        assert.equal(options.headers.Accept, "video/mp4");
        return pretendResponse();
      },
    });
    assert.equal(calls, 1);
    assert.equal(downloaded.files.length, 1);
    assert.equal(downloaded.renderAllowed, false);
    assert.equal(downloaded.publicationAllowed, false);
    assert.equal(downloaded.files[0].rightsApproved, false);
    const record = downloaded.files[0];
    assert.equal(record.sha256,
      createHash("sha256").update(synthMp4).digest("hex"));
    assert.deepEqual(await readFile(record.localPath), synthMp4);
    assert.equal((await stat(record.localPath)).mode & 0o077, 0);

    const goodReview = {
      candidateId: record.candidateId, endSceneId: "beat-04",
      rightsApproved: true, editorialApproved: true,
      thirdPartyRightsCleared: true, reviewedFileSha256: record.sha256,
      rightsReviewedBy: "qa-reviewer",
      licenseEvidence: "Actual NASA source reviewed independently for CI fixture",
      captureDate: "2026-09-29", rightsReviewedAt: "2026-11-13",
      insertFrames: 72,
    };
    const created = await buildReviewedPrivateClipManifest({
      library: lib, quarantined: downloaded.files, reviews: [goodReview],
      assetRoot: join(workspace, "quarantine"),
    });
    assert.equal(created.manifest.assets.length, 1);
    assert.equal(created.manifest.assets[0].sha256, record.sha256);
    assert.equal(created.manifest.assets[0].insertFrames, 72);
    assert.equal(created.manifest.assets[0].sourceUrl,
      lib.candidates.find(c => c.id === record.candidateId).sourcePage);
    assert.equal(created.publicationAllowed, false);
    await assert.rejects(() => buildReviewedPrivateClipManifest({
      library: lib, quarantined: downloaded.files,
      reviews: [{...goodReview, reviewedFileSha256: "0".repeat(64)}],
      assetRoot: join(workspace, "quarantine"),
    }), /exact local file bytes/);
    await assert.rejects(() => buildReviewedPrivateClipManifest({
      library: lib, quarantined: downloaded.files,
      reviews: [{...goodReview, rightsApproved: false}],
      assetRoot: join(workspace, "quarantine"),
    }), /Reviewer must approve/);
    await assert.rejects(() => buildReviewedPrivateClipManifest({
      library: lib, quarantined: downloaded.files,
      reviews: [{...goodReview, captureDate: "REQUIRES_REVIEW"}],
      assetRoot: join(workspace, "quarantine"),
    }), /real dates/);
    await assert.rejects(() => buildReviewedPrivateClipManifest({
      library: lib, quarantined: downloaded.files,
      reviews: [{...goodReview, endSceneId: "beat-20"}],
      assetRoot: join(workspace, "quarantine"),
    }), /endSceneId/);

    const otherPlan = planQuarantineDownloads({
      library: lib, operatorConsent: approval(),
      selections: [selection("nasa:SOURCE-02", "beat-04", videoUrl)],
    });
    await assert.rejects(() => acquireQuarantinedMedia({
      plan: otherPlan, workspace,
      fetchImpl: async () => pretendResponse(synthMp4,
        {length: "999999999"}),
    }), /size limit/);
    await assert.rejects(() => acquireQuarantinedMedia({
      plan: otherPlan, workspace,
      fetchImpl: async () => pretendResponse(synthMp4,
        {type: "application/json"}),
    }), /MIME/);
    await assert.rejects(() => acquireQuarantinedMedia({
      plan: otherPlan, workspace,
      fetchImpl: async () => pretendResponse(synthMp4, {status: 302}),
    }), /200 OK/);
    await assert.rejects(() => acquireQuarantinedMedia({
      plan: otherPlan, workspace,
      fetchImpl: async () => pretendResponse(Buffer.alloc(110, 3)),
    }), /Expected values to be strictly equal/);
    assert.equal((await readFile(record.localPath)).length, synthMp4.length);
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
});
