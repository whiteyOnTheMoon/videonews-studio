import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  LAYERED_FADE_FRAMES,
  createLayeredDimSvg,
  createLayeredForegroundSvg,
  encodeLayeredSequence,
  planLayeredTimeline,
} from "./p3_layered_cinematic_composition.mjs";

function run(command, args, encoding = "utf8") {
  const r = spawnSync(command, args, {
    encoding, timeout: 240000, maxBuffer: 2 * 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(r.status, 0, command + ": " + String(r.stderr ?? "").slice(-1400));
  return r.stdout;
}

function probe(path) {
  return JSON.parse(run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_name,codec_type,nb_frames,width,height",
    "-of", "json", path,
  ]));
}

function pixel(path, seconds, x, y) {
  const r = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", seconds.toFixed(6), "-i", path,
    "-vf", "format=rgb24,crop=1:1:" + x + ":" + y + ":exact=1",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], null);
  assert.equal(r.length, 3);
  return Array.from(r);
}

async function fixture(root, kind, color, seconds, name) {
  const path = join(root, name + (kind === "photo" ? ".jpg" : ".mp4"));
  if (kind === "photo") {
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=" + color + ":s=640x360:r=24",
      "-frames:v", "1", "-q:v", "3", path,
    ]);
  } else {
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=" + color + ":s=640x360:r=24",
      "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=48000",
      "-t", String(seconds),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
      "-threads:v", "1", "-pix_fmt", "yuv420p",
      "-c:a", "aac", path,
    ]);
  }
  return {path, sha256: createHash("sha256").update(await readFile(path)).digest("hex")};
}

function asset({id, role, sceneId, endSceneId, file, kind}) {
  return {
    id, motifId: id + "-unique", role,
    kind, path: file.path, sha256: file.sha256,
    sceneId, endSceneId,
    compositionMode: "layered-cinematic",
    scientificVisualization: role === "science-inset",
    sourceUrl: "https://example.org/ci-synthetic-only/" + id,
    creator: "Original synthetic CI", credit: "Original generated test footage " + id,
    captureDate: "2026-11-13", licenseUrl: "https://example.org/ci-only",
    licenseEvidence: "Generated in this isolated test, not external imagery",
    rightsReviewedBy: "ci-synthetic-fixture-only", rightsReviewedAt: "2026-11-13",
    rightsApproved: true, editorialApproved: true, thirdPartyRightsCleared: true,
  };
}

test("layered news style includes alpha gradient, independent text and science inset", () => {
  const dim = createLayeredDimSvg();
  assert.match(dim, /linearGradient/);
  assert.match(dim, /stop-opacity="0.78"/);
  assert.match(dim, /stop-opacity="0.32"/);
  assert.doesNotMatch(dim, /fill-opacity="1"/);
  const content = createLayeredForegroundSvg({
    visual: {kind: "chart", title: "Visible ozone & climate facts",
      bars: [{label: "Observed", value: 70}]},
    sequence: 2, backgroundCredit: "CI test atmosphere",
    foreground: {role: "science-inset", credit: "Science annotation should not be cropped"},
  });
  assert.match(content, /SCIENTIFIC VISUALIZATION/);
  assert.match(content, /Visible ozone &amp; climate facts/);
  assert.match(content, /BACKGROUND: CI test atmosphere/);
  assert.match(content, /<rect x="748" y="224"/);
  assert.doesNotMatch(content, /EARTH &amp; CLIMATE/);
  assert.equal(LAYERED_FADE_FRAMES, 12);
});

test("two full-bleed moving sources crossfade across five beats under text and reviewed media", async () => {
  const root = await mkdtemp(join(tmpdir(), "p3-layered-"));
  try {
    const red = await fixture(root, "video", "red", 5, "red-motion-with-audio");
    const blue = await fixture(root, "video", "blue", 7, "blue-motion-with-audio");
    const science = await fixture(root, "video", "lime", 3, "science-inset-with-audio");
    const image = await fixture(root, "photo", "orange", 0, "photo-card");
    const backgrounds = [
      asset({id: "bg-red", role: "background", sceneId: "beat-01",
        endSceneId: "beat-02", file: red, kind: "video"}),
      asset({id: "bg-blue", role: "background", sceneId: "beat-03",
        endSceneId: "beat-05", file: blue, kind: "video"}),
      asset({id: "science", role: "science-inset", sceneId: "beat-02",
        endSceneId: "beat-02", file: science, kind: "video"}),
      asset({id: "photo", role: "image-card", sceneId: "beat-04",
        endSceneId: "beat-04", file: image, kind: "photo"}),
    ];
    const beatFrames = Array(5).fill(48);
    const beatVisuals = [
      {kind: "text-card", title: "First atmosphere", body: "News graphic overlay."},
      {kind: "chart", title: "Moving science inset", bars: [
        {label: "Simulated value", value: 42},
      ]},
      {kind: "text-card", title: "Crossfade of backdrops", body: "No hard cut."},
      {kind: "text-card", title: "Still photo as an inset", body: "Independent image."},
      {kind: "text-card", title: "Last moving scene", body: "Background continues."},
    ];
    const input = {manifest: {schemaVersion: 1, assets: backgrounds},
      assetRoot: root, beatFrames, beatVisuals};
    const plan = await planLayeredTimeline(input);
    assert.equal(plan.timelineFrames, 240);
    assert.deepEqual(plan.backgrounds.map(x => x.sourceFrames), [102, 150],
      "Each source supplies half of the 12-frame overlap");
    assert.deepEqual(plan.starts, [0, 48, 96, 144, 192]);
    assert.equal(plan.foreground.length, 2);

    await assert.rejects(() => planLayeredTimeline({
      ...input, manifest: {schemaVersion: 1, assets: backgrounds.map((a, i) =>
        i === 0 ? {...a, rightsApproved: false} : a)},
    }), /Unapproved media/);
    await assert.rejects(() => planLayeredTimeline({
      ...input, manifest: {schemaVersion: 1, assets: backgrounds.map((a, i) =>
        i === 0 ? {...a, sha256: "0".repeat(64)} : a)},
    }), /Digest mismatch/);
    await assert.rejects(() => planLayeredTimeline({
      ...input, manifest: {schemaVersion: 1, assets: backgrounds.map((a, i) =>
        i === 1 ? {...a, endSceneId: "beat-04"} : a)},
    }), /must cover every narrated beat/);
    await assert.rejects(() => planLayeredTimeline({
      ...input, manifest: {schemaVersion: 1, assets: backgrounds.map((a, i) =>
        i === 0 ? {...a, scientificVisualization: true} : a)},
    }), /scientific footage must be a separate foreground inset/);
    await assert.rejects(() => planLayeredTimeline({
      ...input, manifest: {schemaVersion: 1, assets: backgrounds.map((a, i) =>
        i === 2 ? {...a, role: "background", scientificVisualization: false} : a)},
    }), /Layered background spans overlap/);

    const output = join(root, "layered-video-only.mp4");
    await encodeLayeredSequence({plan, output, directory: join(root, "graphics")});
    const info = probe(output);
    assert.equal(info.streams.length, 1, "No source audio in cinematic frames");
    assert.equal(info.streams[0].codec_name, "h264");
    assert.equal(info.streams[0].width, 1280);
    assert.equal(info.streams[0].height, 720);
    assert.equal(Number(info.streams[0].nb_frames), 240);
    assert.ok(Math.abs(Number(info.format.duration) - 10) < 0.1);
    assert.ok((await stat(output)).size > 6000);

    // Measure at unobstructed x=1165,y=575: red before 4s, purple
    // mixed halfway through crossfade, blue after 4s.
    const before = pixel(output, 3.5, 1165, 575);
    const mixed = pixel(output, 4.0, 1165, 575);
    const after = pixel(output, 4.5, 1165, 575);
    assert.ok(before[0] > before[2] + 50, "Initial red background not present " + before);
    assert.ok(after[2] > after[0] + 50, "Second blue background not present " + after);
    assert.ok(mixed[0] > after[0] + 5 && mixed[2] > before[2] + 5,
      "No pixel evidence of a crossfade: " + [before, mixed, after]);

    const voice = join(root, "synthetic-voice.wav");
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "10", "-c:a", "pcm_s16le", voice,
    ]);
    const final = join(root, "private-synthetic-layered.mp4");
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", output, "-i", voice,
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
      "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", final,
    ]);
    const joined = probe(final);
    assert.equal(joined.streams.length, 2);
    assert.equal(joined.streams.find(x => x.codec_type === "audio").codec_name, "aac");
    assert.equal(Number(joined.streams.find(x => x.codec_type === "video").nb_frames), 240);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
