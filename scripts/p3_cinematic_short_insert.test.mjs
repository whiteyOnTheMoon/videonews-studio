import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  encodeCinematicSpan, encodeGraphicTail, planCinematicTimeline,
} from "./p3_cinematic_timeline.mjs";

function run(name, args) {
  const result = spawnSync(name, args, {
    encoding: "utf8", timeout: 120000,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(result.status, 0, name + " " + (result.stderr ?? "").slice(-1400));
  return result.stdout;
}

function probe(path) {
  return JSON.parse(run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_name,codec_type,nb_frames,width,height",
    "-of", "json", path,
  ]));
}

test("a short moving insert transitions to the static graphic without replaying footage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p3-short-insert-"));
  try {
    const source = join(dir, "synthetic-video.mp4");
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "8",
      "-c:v", "libx264", "-threads:v", "1", "-pix_fmt", "yuv420p",
      "-c:a", "aac", source,
    ]);
    const raw = await readFile(source);
    const asset = {
      id: "ci-synthetic-short-motion", motifId: "one-short-clip-motif",
      kind: "video", path: source,
      sha256: createHash("sha256").update(raw).digest("hex"),
      sceneId: "beat-15", endSceneId: "beat-15", insertFrames: 144,
      sourceUrl: "https://example.org/ci-fixture",
      creator: "CI", credit: "Generated science pattern, not real NASA imagery",
      captureDate: "2026-11-13", licenseUrl: "https://example.org/ci-fixture-only",
      licenseEvidence: "CI-owned synthetic fixture for tests only",
      rightsReviewedBy: "ci-fixture", rightsReviewedAt: "2026-11-13",
      rightsApproved: true, editorialApproved: true,
      thirdPartyRightsCleared: true,
    };
    const visuals = Array.from({length: 19}, (_, i) =>
      ({kind: "text-card", title: "Test explanation " + i,
        body: "Ozone data versus a long-term trend"}));
    const beatFrames = Array(19).fill(48);
    beatFrames[14] = 240; // 10s narration: six seconds of motion, four of diagram.
    const photoBeats = Array(19).fill(null);
    photoBeats[0] = 1;
    const input = {
      manifest: {schemaVersion: 1, assets: [asset]},
      assetRoot: dir, beatFrames, beatVisualAssets: photoBeats, beatVisuals: visuals,
    };
    const plan = await planCinematicTimeline(input);
    assert.equal(plan.starts.size, 0);
    assert.equal(plan.inserts.size, 1);
    assert.deepEqual([...plan.occupied], [14]);
    const span = plan.inserts.get(14);
    assert.equal(span.durationFrames, 144);
    assert.deepEqual(span.frames, [144]);
    const movie = join(dir, "video-only.mp4");
    await encodeCinematicSpan({
      span, output: movie, directory: join(dir, "cinematic-images"),
    });
    const a = probe(movie);
    assert.equal(a.streams.length, 1, "Input audio must be excluded");
    assert.equal(Number(a.streams[0].nb_frames), 144);

    const svg = join(dir, "graphic.svg"), png = join(dir, "graphic.png");
    await writeFile(svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">' +
      '<rect width="1280" height="720" fill="#071420"/>' +
      '<text x="80" y="320" font-size="48" fill="white">Original explanation</text>' +
      '</svg>');
    run("rsvg-convert", ["--output", png, svg]);
    const graphic = join(dir, "original-graphic-tail.mp4");
    await encodeGraphicTail({imagePath: png, output: graphic, frames: 96});
    const b = probe(graphic);
    assert.equal(b.streams.length, 1);
    assert.equal(Number(b.streams[0].nb_frames), 96);

    const concat = join(dir, "segments.ffconcat");
    await writeFile(concat, "ffconcat version 1.0\n" +
      "file '" + movie + "'\nfile '" + graphic + "'\n");
    const combined = join(dir, "combined.mp4");
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "concat", "-safe", "0", "-i", concat, "-c:v", "copy",
      "-an", combined,
    ]);
    const joined = probe(combined);
    assert.equal(joined.streams.length, 1);
    assert.equal(Number(joined.streams[0].nb_frames), 240);
    assert.ok(Math.abs(Number(joined.format.duration) - 10) < 0.12);

    await assert.rejects(() => planCinematicTimeline({
      ...input, manifest: {schemaVersion: 1, assets: [{...asset,
        insertFrames: 240}]},
    }), /graphic remainder/);
    await assert.rejects(() => planCinematicTimeline({
      ...input, manifest: {schemaVersion: 1, assets: [{...asset,
        endSceneId: "beat-16"}]},
    }), /within one editorial beat/);
    await assert.rejects(() => planCinematicTimeline({
      ...input, manifest: {schemaVersion: 1, assets: [{...asset,
        insertFrames: 191}]},
    }), /cannot be looped or frozen/);
    await assert.rejects(() => planCinematicTimeline({
      ...input, beatVisualAssets: photoBeats.map((v, i) => i === 14 ? 2 : v),
    }), /photo-backed/);
    await assert.rejects(() => planCinematicTimeline({
      ...input, manifest: {schemaVersion: 1, assets: [{...asset,
        rightsApproved: false}]},
    }), /Unapproved media/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
