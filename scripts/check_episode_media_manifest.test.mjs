import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEpisodeMediaManifest } from "./check_episode_media_manifest.mjs";

test("offline media preflight validates one approved source image", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vns-media-check-"));
  try {
    const path = join(dir, "science.png");
    const raw = Buffer.from("fixture-not-a-real-png");
    await writeFile(path, raw);
    const item = {
      id: "nasa-1", kind: "photo", path,
      sha256: createHash("sha256").update(raw).digest("hex"),
      sourceUrl: "https://science.nasa.gov/",
      creator: "NASA", credit: "NASA test fixture",
      licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
      licenseEvidence: "Fixture review only, no publishing rights granted",
      rightsReviewedBy: "test", rightsReviewedAt: "2026-11-13",
      captureDate: "2026-10-04", sceneId: "s1", motifId: "motif-1",
      rightsApproved: true, editorialApproved: true,
      thirdPartyRightsCleared: true,
    };
    const good = {schemaVersion: 1, assets: [item]};
    assert.equal((await validateEpisodeMediaManifest(good, dir)).photos, 1);
    await assert.rejects(
      () => validateEpisodeMediaManifest({...good, assets: [item, {...item, id: "copy", sceneId: "s2", motifId: "motif-2"}]}, dir),
      /Repeated SHA/,
    );
    await assert.rejects(
      () => validateEpisodeMediaManifest({...good, assets: [{...item, rightsApproved: false}]}, dir),
      /Unapproved media/,
    );
    await assert.rejects(
      () => validateEpisodeMediaManifest({...good, assets: [{...item, sha256: "0".repeat(64)}]}, dir),
      /Digest mismatch/,
    );
    await assert.rejects(
      () => validateEpisodeMediaManifest({...good, assets: [{...item, motifId: ""}]}, dir),
      /motifId/,
    );
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
