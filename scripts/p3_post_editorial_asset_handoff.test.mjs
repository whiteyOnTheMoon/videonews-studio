import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  buildVisualResearchTasks, researchVisualBatch,
  verifyPostEditorialMediaHandoff,
} from "./p3_post_editorial_asset_handoff.mjs";
import {runPostEditorialHandoffCli} from "./p3_post_editorial_asset_handoff_cli.mjs";

function fixture() {
  const counts = [2, 3, 3, 3, 3, 3, 2];
  const sections = ["intro", "basics", "measurements", "polar", "impact", "future", "outro"]
    .map((id, i) => ({
      id,
      visuals: Array.from({length: counts[i]}, (_, j) => ({
        kind: "text-card",
        title: i === 0 && j === 0 ? "Beautiful night sky" :
          i === 0 && j === 1 ? "Antarctic ozone measurement" :
          "Satellite data in Antarctica " + i + " " + j,
        body: "Science content example",
      })),
    }));
  const story = {
    schemaVersion: 1, id: "ozone-2026-explained-en", asOf: "2026-11-13",
    editorialApproved: false, renderAllowed: false,
    uploadAllowed: false, publicationAllowed: false,
    sources: [
      {id: "nasa-2026", url: "https://science.nasa.gov/earth/ozone-test"},
      {id: "noaa-2026", url: "https://www.noaa.gov/ozone-source"},
    ], sections,
  };
  const researchReport = {
    version: 1, eventId: "a".repeat(64),
    profileId: "ozone_report", sourceUrls: [
      "https://science.nasa.gov/earth/ozone-test",
      "https://example.org/another-source",
    ],
    decisions: ["offline_metadata_only", "independent_review_not_attested"],
    approvedForPublication: false,
  };
  const attestation = {
    kind: "post-editorial-media-research-only",
    reviewedStoryId: story.id,
    storySha256: createHash("sha256").update(JSON.stringify(story)).digest("hex"),
    researchEventId: researchReport.eventId,
    reviewerId: "qa-reviewer",
    reviewedAt: "2026-11-13T17:45:00.000Z",
    sourceLinkReviewed: true,
    allowMetadataResearch: true,
    allowMediaDownloads: false,
    allowPublication: false,
  };
  return {story, researchReport, attestation};
}
test("handoff insists on matching research event, story hash, named source review and denied publication", () => {
  const input = fixture();
  const {plan, receipt} = verifyPostEditorialMediaHandoff(input);
  assert.equal(plan.scenes.length, 19);
  assert.equal(receipt.matchingEvidenceSourceUrls.length, 1);
  assert.equal(receipt.rightsApproved, false);
  assert.equal(receipt.publicationAllowed, false);
  assert.equal(receipt.curatedStorySha256, input.attestation.storySha256);
  assert.throws(() => verifyPostEditorialMediaHandoff({
    ...input, attestation: {...input.attestation, storySha256: "0".repeat(64)},
  }), /named review/);
  assert.throws(() => verifyPostEditorialMediaHandoff({
    ...input, attestation: {...input.attestation, allowMediaDownloads: true},
  }), /named review/);
  assert.throws(() => verifyPostEditorialMediaHandoff({
    ...input, story: {...input.story, publicationAllowed: true},
  }), /publication and render gates denied/);
  assert.throws(() => verifyPostEditorialMediaHandoff({
    ...input, researchReport: {...input.researchReport,
      sourceUrls: ["https://another-source.org/"]},
  }), /No matching source URL/);
  assert.throws(() => verifyPostEditorialMediaHandoff({
    ...input, researchReport: {...input.researchReport, approvedForPublication: true},
  }), /candidate-only/);
});
test("small multi-provider batches preserve distinct evidence roles and never download assets", async () => {
  const {plan} = verifyPostEditorialMediaHandoff(fixture());
  const tasks = buildVisualResearchTasks(plan);
  assert.ok(tasks.length > 19 && tasks.length < 40);
  assert.equal(tasks[0].id, "beat-01:pexels");
  assert.equal(tasks[1].id, "beat-02:nasa");
  assert.equal(tasks[2].id, "beat-02:pexels");
  const called = [];
  async function fakeFetch(url, options) {
    called.push({url, options});
    let body;
    if (url.startsWith("https://images-api.nasa.gov")) {
      body = {collection: {items: [{
        data: [{
          nasa_id: "NASA_TEST_" + called.length,
          media_type: "video", title: "Scientific data",
          date_created: "2026-10-05T00:00:00Z",
        }],
      }]}};
    } else {
      body = {videos: [{
        id: 1000 + called.length,
        url: "https://www.pexels.com/video/test-footage-" + called.length + "/",
        user: {name: "Synthetic contributor"},
        duration: 16, width: 1280, height: 720,
        image: "https://images.pexels.com/sample.jpg",
      }]};
    }
    return {ok: true, status: 200,
      headers: {get: () => null},
      text: async () => JSON.stringify(body)};
  }
  const first = await researchVisualBatch({
    plan, tasks, budget: 4, cursor: 0,
    pexelsKey: "TEST_LOCAL_KEY", fetchImpl: fakeFetch,
  });
  assert.equal(first.nextCursor, 4);
  assert.equal(first.complete, false);
  assert.equal(called.length, 4);
  assert.equal(first.library.candidates.length, 4);
  assert.equal(first.queriesAttempted, 4);
  assert.ok(first.library.candidates.every(item =>
    item.rightsApproved === false &&
    item.editorialApproved === false &&
    item.thirdPartyRightsCleared === false &&
    item.downloadStatus === "NOT_DOWNLOADED"));
  assert.ok(first.library.candidates.some(item =>
    item.provider === "nasa" &&
    item.visualRole === "SCIENTIFIC_SOURCE_REVIEW_REQUIRED"));
  assert.ok(first.library.candidates.some(item =>
    item.provider === "pexels" &&
    item.visualRole === "CONTEXT_ONLY_NOT_EVIDENCE"));
  assert.ok(called.every(c => c.options.redirect === "error"));
  assert.ok(called.some(c => c.options.headers.Authorization === "TEST_LOCAL_KEY"));
  assert.doesNotMatch(JSON.stringify(first), /TEST_LOCAL_KEY/);

  const second = await researchVisualBatch({
    plan, tasks, budget: 4, cursor: first.nextCursor,
    previous: first.library, pexelsKey: "TEST_LOCAL_KEY", fetchImpl: fakeFetch,
  });
  assert.equal(second.nextCursor, 8);
  assert.equal(second.library.candidates.length, 8);
  assert.equal(called.length, 8);
  assert.ok(second.library.candidates.every(item =>
    item.selection === "ALTERNATIVE"));

  const noKey = await researchVisualBatch({
    plan, tasks, budget: 3, cursor: 0, fetchImpl: fakeFetch,
  });
  assert.equal(noKey.queryLog.filter(x => x.status === "API_KEY_UNAVAILABLE").length, 2);
  assert.equal(noKey.queriesAttempted, 1);
  assert.equal(called.length, 9);
  await assert.rejects(() => researchVisualBatch({
    plan, tasks, budget: 6, fetchImpl: fakeFetch,
  }), /assert/i);
  await assert.rejects(() => researchVisualBatch({
    plan, tasks: tasks.map((task, i) =>
      i === 0 ? {...task, sceneId: "beat-19"} : task),
    fetchImpl: fakeFetch,
  }), /schedule/);
  await assert.rejects(() => researchVisualBatch({
    plan, tasks, previous: {...first.library, episodeId: "different-episode"},
    cursor: 4, fetchImpl: fakeFetch,
  }), /another episode/);
  await assert.rejects(() => researchVisualBatch({
    plan, tasks, previous: {...first.library,
      candidates: first.library.candidates.map(c => ({...c, rightsApproved: true}))},
    cursor: 4, fetchImpl: fakeFetch,
  }), /never accept already approved/);
});
test("private CLI creates an offline checkpoint, resumes deterministically, rejects stale story", async () => {
  const input = fixture();
  const base = await mkdtemp(join(tmpdir(), "p3-post-editorial-"));
  try {
    const root = join(base, "media-root");
    await mkdir(root, {mode: 0o700});
    const storyPath = join(base, "story.json");
    const reportPath = join(base, "report.json");
    const attestationPath = join(base, "attestation.json");
    await writeFile(storyPath, JSON.stringify(input.story));
    await writeFile(reportPath, JSON.stringify(input.researchReport));
    await writeFile(attestationPath, JSON.stringify(input.attestation));
    const args = [storyPath, reportPath, attestationPath, root];
    const first = await runPostEditorialHandoffCli(args);
    assert.equal(first.status, "PLAN_ONLY_NO_NETWORK");
    assert.equal(first.tasksCompleted, 0);
    assert.equal(first.mediaDownloads, 0);
    assert.equal(first.publicationAllowed, false);
    const path = join(first.workspace, "post-editorial-asset-library.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.library.candidates.length, 0);
    assert.ok(saved.tasksTotal > 19);
    assert.equal(saved.handoff.researchEventId, "a".repeat(64));
    const resumed = await runPostEditorialHandoffCli([
      ...args, "--resume=" + first.workspace,
    ]);
    assert.equal(resumed.workspace, first.workspace);
    assert.equal(resumed.tasksCompleted, 0);
    const modified = {...input.attestation, storySha256: "f".repeat(64)};
    await writeFile(attestationPath, JSON.stringify(modified));
    await assert.rejects(() => runPostEditorialHandoffCli([
      ...args, "--resume=" + first.workspace,
    ]), /named review/);
  } finally {
    await rm(base, {recursive: true, force: true});
  }
});
