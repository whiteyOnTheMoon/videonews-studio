import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {encodeCinematicSpan, planCinematicTimeline} from "./p3_cinematic_timeline.mjs";
import {
  SCIENCE_SAFE_MODE, SCIENCE_VIEWPORT,
  createScienceSafeBrandSvg, createScienceSafeOverlaySvg,
  requiresScienceSafeMode, scienceSafeBaseGraph,
} from "./p3_science_safe_composition.mjs";

function run(name, args, encoding = "utf8") {
  const result = spawnSync(name, args, {
    encoding, timeout: 180000, maxBuffer: 2 * 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(result.status, 0,
    name + ": " + String(result.stderr ?? "").slice(-1400));
  return result.stdout;
}

function pixel(path, x, y) {
  const result = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-ss", "2.5", "-i", path,
    "-vf", "format=rgb24,crop=1:1:" + x + ":" + y + ":exact=1",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], null);
  assert.equal(result.length, 3);
  return Array.from(result);
}

test("science-safe layout places every caption outside the entire source frame", () => {
  assert.deepEqual(SCIENCE_VIEWPORT, {x: 320, y: 90, width: 960, height: 540});
  const text = createScienceSafeOverlaySvg({
    kind: "text-card", title: "<Ozone & temperature>",
    body: "Date and color legend must stay legible across the full source image.",
  }, 15);
  assert.match(text, /&lt;Ozone &amp; temperature&gt;/);
  assert.match(text, /clip-path="url\(#science-rail\)"/);
  assert.match(text, /width="288"/);
  assert.doesNotMatch(text, /fill-opacity="0.74"/);
  const bar = createScienceSafeOverlaySvg({
    kind: "chart", title: "Independent measured series",
    bars: [{label: "Measured", value: 93}, {label: "Previous", value: 75}],
  }, 16);
  assert.match(bar, /Measured/);
  assert.match(bar, /width="246"/);
  const brand = createScienceSafeBrandSvg("CI synthetic only", "2026-11-13");
  assert.match(brand, /NOT FOR PUBLICATION/);
  assert.match(brand, /science-custody/);
  assert.equal(requiresScienceSafeMode({
    sourceUrl: "https://ozonewatch.gsfc.nasa.gov/fixture-not-downloaded",
  }), true);
  assert.equal(requiresScienceSafeMode({
    sourceUrl: "https://example.org/fixture", scientificVisualization: true,
  }), true);
  assert.equal(requiresScienceSafeMode({sourceUrl: "https://example.org/fixture"}), false);
  const graph = scienceSafeBaseGraph("4.000000", "0.416667", "3.583333").join(";");
  assert.match(graph, /force_original_aspect_ratio=decrease/);
  assert.match(graph, /overlay=320:90/);
  assert.doesNotMatch(graph, /crop=/);
  assert.throws(() => scienceSafeBaseGraph("NaN", "0.416667", "3.583333"),
    /frame-exact/);
});

test("synthetic NASA-like four-corner science annotations survive video composition", async () => {
  const root = await mkdtemp(join(tmpdir(), "p3-science-safe-"));
  try {
    const source = join(root, "synthetic-data-with-audio.mp4");
    // Four contrasting corner markers stand in for date, color legend,
    // caption and scientific scale. They must all remain visible.
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i",
      "color=c=0x203044:s=1280x720:r=24," +
        "drawbox=x=0:y=0:w=180:h=170:color=red:t=fill," +
        "drawbox=x=1100:y=0:w=180:h=170:color=green:t=fill," +
        "drawbox=x=0:y=550:w=180:h=170:color=blue:t=fill," +
        "drawbox=x=1100:y=550:w=180:h=170:color=yellow:t=fill",
      "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000",
      "-t", "5", "-c:v", "libx264", "-preset", "ultrafast",
      "-crf", "18", "-threads:v", "1", "-pix_fmt", "yuv420p",
      "-c:a", "aac", source,
    ]);
    const sha256 = createHash("sha256").update(await readFile(source)).digest("hex");
    const asset = {
      id: "synthetic-science", motifId: "four-corner-fixture",
      kind: "video", path: source, sha256,
      sceneId: "beat-15", endSceneId: "beat-16",
      scientificVisualization: true, compositionMode: SCIENCE_SAFE_MODE,
      sourceUrl: "https://example.org/local-synthetic-test-only",
      creator: "CI synthetic generator", credit: "Offline synthetic science corners",
      captureDate: "2026-11-13", licenseUrl: "https://example.org/ci-only",
      licenseEvidence: "Locally generated solely for CI; no external content",
      rightsReviewedBy: "CI-fixture-only", rightsReviewedAt: "2026-11-13",
      rightsApproved: true, editorialApproved: true, thirdPartyRightsCleared: true,
    };
    const beats = Array(19).fill(48);
    const visuals = Array.from({length: 19}, (_, i) => ({
      kind: "text-card", title: "Scientific fact beat " + (i + 1),
      body: "Measured versus projected ozone; interpretation does not cover raw data.",
    }));
    visuals[15] = {kind: "chart", title: "Ozone measurements", bars: [
      {label: "Reference", value: 93}, {label: "Observation", value: 75},
    ]};
    const args = {manifest: {schemaVersion: 1, assets: [asset]},
      assetRoot: root, beatFrames: beats, beatVisuals: visuals,
      beatVisualAssets: Array(19).fill(null)};
    const plan = await planCinematicTimeline(args);
    const span = plan.starts.get(14);
    assert.equal(span.compositionMode, SCIENCE_SAFE_MODE);
    assert.deepEqual(span.frames, [48, 48]);

    await assert.rejects(() => planCinematicTimeline({
      ...args, manifest: {schemaVersion: 1, assets: [
        {...asset, compositionMode: undefined},
      ]},
    }), /Scientific visualization requires science-safe/);
    await assert.rejects(() => planCinematicTimeline({
      ...args, manifest: {schemaVersion: 1, assets: [
        {...asset, compositionMode: "future-overpaint"},
      ]},
    }), /Unknown cinematic composition mode/);
    await assert.rejects(() => planCinematicTimeline({
      ...args, manifest: {schemaVersion: 1, assets: [
        {...asset, scientificVisualization: "false", compositionMode: "standard"},
      ]},
    }), /scientificVisualization must be boolean/);
    await assert.rejects(() => planCinematicTimeline({
      ...args, manifest: {schemaVersion: 1, assets: [
        {...asset, rightsApproved: false},
      ]},
    }), /Unapproved media/);
    await assert.rejects(() => planCinematicTimeline({
      ...args, manifest: {schemaVersion: 1, assets: [
        {...asset, sourceUrl: "https://ozonewatch.gsfc.nasa.gov/metadata-only",
          scientificVisualization: false, compositionMode: "standard"},
      ]},
    }), /Scientific visualization requires science-safe/);

    const output = join(root, "private-synthetic-science-safe.mp4");
    const directory = join(root, "overlay-workspace");
    await encodeCinematicSpan({span, output, directory});
    const probe = JSON.parse(run("ffprobe", [
      "-v", "error", "-show_entries",
      "format=duration:stream=codec_name,codec_type,width,height,nb_frames",
      "-of", "json", output,
    ]));
    assert.equal(probe.streams.length, 1, "No source audio in science export");
    assert.equal(probe.streams[0].codec_name, "h264");
    assert.equal(probe.streams[0].width, 1280);
    assert.equal(probe.streams[0].height, 720);
    assert.equal(Number(probe.streams[0].nb_frames), 96);
    assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.08);

    // The render occupies x=320..1279, y=90..629. All corners represent
    // metadata near the original frame edges, not an idealized central crop.
    const red = pixel(output, 339, 110);
    const green = pixel(output, 1258, 110);
    const blue = pixel(output, 339, 609);
    const yellow = pixel(output, 1258, 609);
    assert.ok(red[0] > 175 && red[1] < 90 && red[2] < 90, "Top-left date lost: " + red);
    assert.ok(green[1] > 80 && green[0] < 90 && green[2] < 90,
      "Top-right legend lost: " + green);
    assert.ok(blue[2] > 175 && blue[0] < 90 && blue[1] < 90,
      "Bottom-left scale lost: " + blue);
    assert.ok(yellow[0] > 175 && yellow[1] > 145 && yellow[2] < 90,
      "Bottom-right caption lost: " + yellow);
    const svg = await readFile(join(directory, "cinematic-15-1.svg"), "utf8");
    assert.match(svg, /science-rail/);
    const brand = await readFile(join(directory, "cinematic-15-brand.svg"), "utf8");
    assert.match(brand, /science-custody/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
