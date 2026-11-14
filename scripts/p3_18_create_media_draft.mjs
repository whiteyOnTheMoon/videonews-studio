#!/usr/bin/env node
/**
 * Inspect only: create a SHA-256 inventory for five manually staged NASA
 * candidates. NEVER grants render, editorial or third-party rights.
 * No remote requests, worker activation, changes to sources or publication.
 *
 * node scripts/p3_18_create_media_draft.mjs <private-asset-root> <output-json>
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {lstat, readFile, realpath, writeFile} from "node:fs/promises";
import {basename, isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const inputFiles = Object.freeze({
  "svs-earth-5570": "svs-earth-5570.mp4",
  "svs-earth-spheres-31365": "svs-earth-spheres-31365.mp4",
  "svs-pace-31365": "svs-pace-31365.mp4",
  "nasa-ozone-map-2026": "nasa-ozone-map-2026.jpg",
  "nasa-ozone-video-2026": "nasa-ozone-video-2026.mp4",
});
const STORY_CATALOG = new URL("../content/media/p3-18-ozone-pilot-candidate-review.json", import.meta.url);

export function makeUnapprovedInventory({root, catalog, files}) {
  assert.ok(isAbsolute(root));
  assert.equal(catalog.status, "INSPECTED_UNAPPROVED");
  assert.equal(catalog.candidates.length, 5);
  const assets = catalog.candidates.map(item => {
    const data = files[item.id];
    assert.ok(data && typeof data.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(data.sha256));
    if (item.expectedSha256) assert.equal(data.sha256, item.expectedSha256,
      "Pinned known NASA checksum mismatch: " + item.id);
    assert.ok(data.path.startsWith(root + "/"));
    return {
      id: item.id, candidateId: item.id, motifId: item.id + "-individual",
      kind: item.type, role: item.role, compositionMode: "layered-cinematic",
      scientificVisualization: item.role === "science-inset",
      sceneId: item.sceneId, endSceneId: item.endSceneId,
      path: data.path, sha256: data.sha256, sourceUrl: item.sourcePage,
      creator: item.creator, credit: item.credit,
      captureDate: "2026-11-13",
      licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
      licenseEvidence: "PENDING ITEM-SPECIFIC RIGHTS AND THIRD-PARTY EVIDENCE",
      rightsReviewedBy: "PENDING", rightsReviewedAt: "2026-11-13",
      reviewReceipt: "PENDING FILE-SPECIFIC LEGAL AND EDITORIAL ATTESTATION",
      atmosphericVisualReview: false,
      contentClassification: "PENDING",
      sourceDateEvidence: "PENDING EXACT OBSERVATION OR RELEASE DATE DOCUMENTATION",
      rightsApproved: false, editorialApproved: false,
      thirdPartyRightsCleared: false,
    };
  });
  return {schemaVersion: 1, status: "INSPECTED_UNAPPROVED",
    privateUseScope: "DRAFT_UNAPPROVED", assetRoot: root,
    publicationAllowed: false, assets};
}

async function main() {
  assert.equal(process.argv.length, 4, "Expected private asset-root and output JSON path");
  const root = process.argv[2], output = process.argv[3];
  assert.ok(isAbsolute(root) && isAbsolute(output), "Absolute private paths only");
  assert.ok(root.startsWith("/home/ap/") && output.startsWith("/home/ap/"),
    "Real candidate intake must stay in ap's private area");
  const details = await lstat(root);
  assert.ok(details.isDirectory() && !details.isSymbolicLink());
  const canonical = await realpath(root);
  assert.equal(canonical, root, "No redirected asset-root symlink");
  assert.ok((details.mode & 0o077) === 0, "Private root must not be accessible to others");
  const catalog = JSON.parse(await readFile(STORY_CATALOG, "utf8"));
  const files = {};
  for (const candidate of catalog.candidates) {
    const base = inputFiles[candidate.id];
    assert.ok(base && basename(base) === base);
    const path = join(root, base);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() &&
      info.size > 15000 && info.size <= 300 * 1024 * 1024);
    assert.equal(await realpath(path), path);
    const data = await readFile(path);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (candidate.expectedSha256) assert.equal(sha256,
      candidate.expectedSha256, "Known NASA file SHA mismatch");
    const cmd = spawnSync("ffprobe", ["-v", "error",
      "-protocol_whitelist", "file,pipe", "-show_entries",
      "stream=codec_name,codec_type,width,height:format=duration",
      "-of", "json", path], {
      encoding: "utf8", timeout: 20000, maxBuffer: 512 * 1024,
      env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
    });
    assert.equal(cmd.status, 0, "Unprobed candidate " + candidate.id);
    const probe = JSON.parse(cmd.stdout);
    const video = probe.streams.find(x => x.codec_type === "video");
    assert.ok(video && video.width >= 640 && video.height >= 360);
    if (candidate.type === "video") {
      assert.equal(video.codec_name, "h264", "Only H264 may enter pilot");
      assert.ok(Number(probe.format.duration) >= candidate.expectedMinimumSeconds,
        "Candidate is shorter than assigned source footage");
    }
    files[candidate.id] = {path, sha256};
  }
  const manifest = makeUnapprovedInventory({root, catalog, files});
  const outputInfo = output.startsWith(root + "/");
  assert.ok(outputInfo, "Draft must remain inside reviewed root");
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n",
    {mode: 0o600, flag: "wx"});
  console.log("P3_18_UNAPPROVED_DRAFT=" + output);
  console.log("ALL_FIVE_REAL_CANDIDATE_BYTES_INSPECTED=YES");
  console.log("P3_18_RIGHTS_APPROVED=NO; PRIVATE_RENDER_ALLOWED=NO");
}

if (process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
