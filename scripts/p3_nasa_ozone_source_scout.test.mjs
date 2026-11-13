import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectNasaOzoneCandidate,
  NASA_OZONE_VIDEO_CANDIDATES,
} from "./p3_nasa_ozone_source_scout.mjs";
import {validateEpisodeMediaManifest} from "./check_episode_media_manifest.mjs";

test("NASA source scout emits inspected-but-unapproved manifest for synthetic local MP4", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p3-nasa-source-scout-"));
  try {
    const file = join(dir, "offline-fixture.mp4");
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
      "-frames:v", "72", "-c:v", "libx264", "-threads:v", "1",
      "-pix_fmt", "yuv420p", "-an", file,
    ], {encoding: "utf8", timeout: 120000,
      env: {PATH: process.env.PATH ?? "/usr/bin:/bin"}});
    assert.equal(r.status, 0, r.stderr);
    const result = await inspectNasaOzoneCandidate({
      candidateId: "ozonewatch-2026-southern", file,
    });
    assert.equal(result.status, "INSPECTED_UNAPPROVED");
    assert.equal(result.media.width, 640);
    assert.ok(Math.abs(result.media.durationSeconds - 3) <= 0.05);
    assert.match(result.media.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.draft.assets[0].sha256, result.media.sha256);
    assert.equal(result.draft.assets[0].rightsApproved, false);
    assert.equal(result.draft.assets[0].editorialApproved, false);
    assert.equal(result.draft.assets[0].thirdPartyRightsCleared, false);
    assert.equal(result.draft.assets[0].captureDate, "REQUIRES_REVIEW");
    assert.match(result.observationLabel, /2026 seasonal sequence/);
    assert.match(result.note, /not proof/);
    await assert.rejects(
      () => validateEpisodeMediaManifest(result.draft, dir),
      /Unapproved media/,
    );
    assert.match(
      NASA_OZONE_VIDEO_CANDIDATES["nasa-svs-1979-2025"].observationLabel,
      /NOT 2026/,
    );
    await assert.rejects(() => inspectNasaOzoneCandidate({
      candidateId: "made-up-source", file,
    }), /enumerated NASA/);
    await assert.rejects(() => inspectNasaOzoneCandidate({
      candidateId: "ozonewatch-2026-southern", file: "fixture.mp4",
    }), /absolute local/);
    const link = join(dir, "symlink.mp4");
    await symlink(file, link);
    await assert.rejects(() => inspectNasaOzoneCandidate({
      candidateId: "ozonewatch-2026-southern", file: link,
    }), /Invalid or unsafe/);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
