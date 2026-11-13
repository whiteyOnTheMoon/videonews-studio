import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  dhashDistance, fingerprintGrayscale9x8,
  fingerprintPrivateMedia, inspectEpisodeVisualDuplicates,
} from "./p3_visual_similarity.mjs";
import {buildEpisodeAssetResearchPlan, createEpisodeMediaLibrary} from
  "./p3_episode_asset_library.mjs";
import {buildOfflineMediaBoard} from "./p3_media_review_board.mjs";

const SHA_A = "a".repeat(64), SHA_B = "b".repeat(64);
const v = (dhash, reliable = true) => ({dhash, mean: 125, contrast: 48, reliable});
function sample(candidateId, sceneId, sha256, values, mediaType = "video") {
  return {candidateId, sceneId, sha256, mediaType: mediaType,
    samples: values};
}
function ffmpeg(args) {
  const r = spawnSync("ffmpeg", args, {
    encoding: "utf8", timeout: 90000,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(r.status, 0, "FFmpeg fixture failed: " +
    (r.stderr ?? "").slice(-500) + " error=" + (r.error?.message ?? "none"));
}
function fixtureLibrary() {
  const story = {
    schemaVersion: 1, id: "ozone-2026-explained-en", asOf: "2026-11-13",
    sections: ["hook","basics","measurements","vortex","impact","next","takeaways"]
      .map((id, i) => ({
        id, visuals: Array.from({length: [2,3,3,3,3,3,2][i]},
          (_, j) => ({title: "Antarctic ozone explanation " + id + " " + j})),
      })),
  };
  const plan = buildEpisodeAssetResearchPlan(story);
  return createEpisodeMediaLibrary(plan, [
    ...["ANIM-A", "ANIM-B"].map((providerId, i) => ({
      sceneId: i ? "beat-03" : "beat-02", provider: "nasa",
      providerId, mediaType: "video",
      title: "Antarctic ozone satellite observations",
      creator: "CI generated source", credit: "CI synthetic material",
      sourcePage: "https://images.nasa.gov/details/" + providerId,
      licensePage: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
    })),
  ]);
}

test("64-bit grayscale dHash detects altered pixels without accepting flat scenes", () => {
  const raw = Buffer.from(Array.from({length:72}, (_, i) =>
    (i % 9) % 2 === 0 ? (25 + Math.floor(i / 9) * 2) :
      (210 - Math.floor(i / 9) * 2)));
  const first = fingerprintGrayscale9x8(raw);
  const second = fingerprintGrayscale9x8(Buffer.from(raw));
  assert.equal(first.dhash, second.dhash);
  assert.equal(first.dhash.length, 16);
  assert.equal(first.reliable, true);
  assert.equal(dhashDistance("0000000000000000", "ffffffffffffffff"), 64);
  assert.equal(dhashDistance("0000000000000000", "0000000000000003"), 2);
  assert.throws(() => dhashDistance("bad", "aaaaaaaaaaaaaaaa"), /assert|pattern/i);
  const blank = fingerprintGrayscale9x8(Buffer.alloc(72, 105));
  assert.equal(blank.reliable, false);
  assert.equal(blank.contrast, 0);
});

test("possible visual matches are review hints; exact byte reuse remains distinct", () => {
  const first = sample("nasa:A", "beat-02", SHA_A,
    [v("aaaaaaaaaaaaaaaa"), v("5555555555555555"), v("00000000ffffffff")]);
  const close = sample("nasa:B", "beat-08", SHA_B,
    [v("aaaaaaaaaaaaaaab"), v("5555555555555554"), v("00000000ffffffff")]);
  const wrong = sample("nasa:C", "beat-09", "c".repeat(64),
    [v("ffffffffffffffff"), v("ffffffffffffffff"), v("ffffffffffffffff")]);
  const flat = sample("nasa:D", "beat-10", "d".repeat(64),
    [v("aaaaaaaaaaaaaaaa", false), v("5555555555555555", false),
      v("00000000ffffffff", false)]);
  const sameBytes = sample("nasa:E", "beat-11", SHA_A,
    [v("0123456789abcdef"), v("0123456789abcdef"),
      v("0123456789abcdef")]);
  const result = inspectEpisodeVisualDuplicates([
    first, close, wrong, flat, sameBytes,
  ]);
  assert.equal(result.possiblePairs, 2);
  assert.ok(result.pairs.some(p =>
    p.candidateA === "nasa:A" && p.candidateB === "nasa:B" &&
    p.kind === "POSSIBLE_VISUAL_NEAR_DUPLICATE" &&
    p.matchedSamples >= 2));
  assert.ok(result.pairs.some(p =>
    p.candidateA === "nasa:A" && p.candidateB === "nasa:E" &&
    p.kind === "EXACT_FILE_DUPLICATE"));
  assert.equal(result.automaticallyRejected, 0);
  assert.equal(result.publicationAllowed, false);
  assert.throws(() => inspectEpisodeVisualDuplicates([first, first]),
    /Malformed or repeated/);
  const onlyFlat = inspectEpisodeVisualDuplicates([
    flat, sample("nasa:F", "beat-12", "f".repeat(64),
      [v("aaaaaaaaaaaaaaaa", false)], "photo"),
  ]);
  assert.equal(onlyFlat.possiblePairs, 0);
});

test("local 3-frame H264 sampling is checksum verified and never reads provider URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "p3-visual-dhash-"));
  try {
    const file = join(root, "synthetic.mp4");
    ffmpeg([
      "-hide_banner","-loglevel","error","-nostdin","-y",
      "-f","lavfi","-i","testsrc2=size=640x360:rate=24",
      "-t","2","-c:v","libx264","-threads:v","1",
      "-pix_fmt","yuv420p","-an",file,
    ]);
    const raw = await readFile(file);
    const digest = createHash("sha256").update(raw).digest("hex");
    const found = await fingerprintPrivateMedia({
      file, sha256: digest, candidateId: "nasa:A", sceneId: "beat-02",
    });
    assert.equal(found.samples.length, 3);
    assert.ok(found.samples.every(s => s.dhash.length === 16));
    assert.equal(found.mediaType, "video");
    assert.equal(found.algorithm,
      "DHASH_9X8_GRAY_WITH_LUMINANCE_AND_CONTRAST_V1");
    await assert.rejects(() => fingerprintPrivateMedia({
      file, sha256: "0".repeat(64), candidateId:"nasa:A",sceneId:"beat-02",
    }), /Fingerprint source SHA/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("private offline board displays exact duplicates across scenes, without auto selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "p3-visual-board-"));
  try {
    const workspace = join(root, "episode");
    const quarantine = join(workspace, "quarantine");
    await mkdir(workspace, {mode: 0o700});
    await mkdir(quarantine, {mode: 0o700});
    const source = join(root, "source.mp4");
    ffmpeg([
      "-hide_banner","-loglevel","error","-nostdin","-y",
      "-f","lavfi","-i","testsrc2=size=640x360:rate=24",
      "-t","1","-c:v","libx264","-threads:v","1",
      "-pix_fmt","yuv420p","-an",source,
    ]);
    const bytes = await readFile(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const localPath = join(quarantine, sha256 + ".mp4");
    await writeFile(localPath, bytes, {mode: 0o600});
    const library = fixtureLibrary();
    const records = library.candidates.map(c => ({
      candidateId: c.id, sceneId: c.sceneId,
      motifId: c.motifId, sha256, localPath,
      status: "QUARANTINED_REVIEW_REQUIRED",
      rightsApproved: false, editorialApproved: false,
      thirdPartyRightsCleared: false,
    }));
    const board = await buildOfflineMediaBoard({
      libraryDocument: {library}, workspace,
      receipt: {
        schemaVersion:1, episodeId:library.episodeId,
        status:"QUARANTINE_ONLY_REQUIRES_REVIEW", records,
      },
    });
    assert.equal(board.localPreviews, 2);
    assert.equal(board.visualReport.possiblePairs, 1);
    assert.equal(board.visualReport.pairs[0].kind, "EXACT_FILE_DUPLICATE");
    assert.match(board.html, /Visuelle Ähnlichkeit prüfen/);
    assert.match(board.html, /Identische Mediendatei/);
    assert.match(board.html, /Bildähnlichkeitsprüfung/);
    assert.match(board.html, /Kein automatischer Ausschluss/);
    assert.match(board.html, /img-src data:/);
    assert.doesNotMatch(board.html, /<img[^>]+src="https:/);
    const wrongScene = structuredClone(records);
    wrongScene[1].sceneId = "beat-14";
    await assert.rejects(() => buildOfflineMediaBoard({
      libraryDocument: {library}, workspace,
      receipt: {schemaVersion:1,episodeId:library.episodeId,
        status:"QUARANTINE_ONLY_REQUIRES_REVIEW",records:wrongScene},
    }), /original episode scene and motif/);
  } finally {
    await rm(root, {recursive:true,force:true});
  }
});
