import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPrivateClipOverlaySvg,
  encodePrivateClipBeat,
  planPrivateClipAssignments,
} from "./p3_private_clip_support.mjs";

function exec(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: 120000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  assert.equal(result.status, 0,
    command + ": " + (result.stderr ?? "").slice(-1000));
  return result.stdout;
}

test("real FFmpeg motion beat uses one approved synthetic MP4, without its source audio", async () => {
  // Synthetic generated content is only a test fixture, never approved footage.
  const root = await mkdtemp(join(tmpdir(), "p3-clip-smoke-"));
  try {
    const input = join(root, "synthetic-source.mp4");
    exec("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "4", "-c:v", "libx264", "-threads:v", "1",
      "-pix_fmt", "yuv420p", "-c:a", "aac", input,
    ]);
    const raw = await readFile(input);
    const item = {
      id: "synthetic-ci-fixture", sceneId: "beat-02", motifId: "synthetic-moving-bars",
      kind: "video", path: input,
      sha256: createHash("sha256").update(raw).digest("hex"),
      sourceUrl: "https://example.org/fixture",
      creator: "CI synthetic generator",
      credit: "CI synthetic video only",
      captureDate: "2026-11-13",
      licenseUrl: "https://example.org/ci-only",
      licenseEvidence: "CI-only generated synthetic video, no real-world clip rights",
      rightsReviewedBy: "ci-fixture", rightsReviewedAt: "2026-11-13",
      rightsApproved: true, editorialApproved: true,
      thirdPartyRightsCleared: true,
    };
    const manifest = {schemaVersion: 1, assets: [item]};
    const beatVisualAssets = Array(19).fill(null);
    beatVisualAssets[0] = 1;
    const beatFrames = Array(19).fill(48);
    const beatTitles = Array(19).fill("Example & <science> title");
    const assignments = await planPrivateClipAssignments({
      manifest, assetRoot: root, beatVisualAssets, beatFrames, beatTitles,
    });
    assert.equal(assignments.size, 1);
    assert.equal(assignments.get(1).sceneId, "beat-02");

    await assert.rejects(() => planPrivateClipAssignments({
      manifest: {schemaVersion: 1, assets: [{...item, sceneId: "beat-01"}]},
      assetRoot: root, beatVisualAssets, beatFrames, beatTitles,
    }), /photo-backed/);
    await assert.rejects(() => planPrivateClipAssignments({
      manifest, assetRoot: root, beatVisualAssets,
      beatFrames: Array(19).fill(240), beatTitles,
    }), /Do not loop or freeze/);

    const svg = createPrivateClipOverlaySvg({
      title: beatTitles[1], credit: item.credit, captureDate: item.captureDate,
    });
    assert.match(svg, /Example &amp; &lt;science&gt; title/);
    assert.match(svg, /PRIVATE PREVIEW - NOT FOR PUBLICATION/);
    const svgFile = join(root, "overlay.svg");
    const pngFile = join(root, "overlay.png");
    await writeFile(svgFile, svg);
    exec("rsvg-convert", ["--output", pngFile, svgFile]);
    const output = join(root, "encoded-beat.mp4");
    await encodePrivateClipBeat({
      assignment: assignments.get(1), overlayPng: pngFile,
      output, frames: 48,
    });
    const details = JSON.parse(exec("ffprobe", [
      "-v", "error", "-show_entries",
      "format=duration:stream=codec_name,codec_type,width,height,nb_frames",
      "-of", "json", output,
    ]));
    assert.equal(details.streams.length, 1, "Input audio must not leak into episode");
    assert.equal(details.streams[0].codec_name, "h264");
    assert.equal(Number(details.streams[0].nb_frames), 48);
    assert.equal(details.streams[0].width, 1280);
    assert.equal(details.streams[0].height, 720);
    assert.ok(Math.abs(Number(details.format.duration) - 2) < 0.1);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
