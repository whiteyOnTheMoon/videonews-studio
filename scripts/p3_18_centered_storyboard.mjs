#!/usr/bin/env node
/**
 * P3-18 v2: PRIVATE, STILL-ONLY editorial storyboard using the operator's
 * 13 pre-audited ORIGINAL NASA contact JPEGs. This deliberately NEVER:
 *   - decodes/edits a source NASA video or original map;
 *   - renders a moving real-media movie;
 *   - infers NASA, science, third-party, or Piper license clearance;
 *   - changes the existing INSPECTED_UNAPPROVED manifest.
 * Six large center-aligned science / news images and one private contact
 * sheet allow VISUAL REVIEW without granting real-video rights.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {spawnSync} from "node:child_process";
import {
  lstat, mkdir, readFile, realpath, rm, stat, writeFile,
} from "node:fs/promises";
import {userInfo} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createLayeredDimSvg} from "./p3_layered_cinematic_composition.mjs";
import {
  createMinuteEditorialOverlaySvg, minuteMediaPlacement,
} from "./p3_minute_editorial_layout.mjs";
import {loadOzonePilot} from "./p3_ozone_minute_private_pilot.mjs";

const ROOT = "/home/ap/videonews-previews";
const AUDIT = join(ROOT, "p3-18-real-source-audit");
const TARGET = join(ROOT, "p3-18-centered-storyboard-v2");
const SOURCE_MANIFEST = "/home/ap/vns-p3-18-private-candidates/ozone-pilot-UNAPPROVED.json";

export const STORYBOARD_ASSIGNMENTS = Object.freeze([
  {beat: 1, background: "svs-earth-5570", frame: 1},
  {beat: 2, background: "svs-earth-5570", frame: 3},
  {beat: 3, background: "svs-earth-spheres-31365", frame: 2},
  {beat: 4, background: "svs-earth-spheres-31365", frame: 3,
    media: "nasa-ozone-video-2026", mediaFrame: 3},
  {beat: 5, background: "svs-pace-31365", frame: 2,
    media: "nasa-ozone-map-2026", mediaFrame: 1},
  {beat: 6, background: "svs-pace-31365", frame: 3},
]);

function command(exe, args, timeout = 90000) {
  const r = spawnSync(exe, args, {
    encoding: "utf8", shell: false, timeout,
    maxBuffer: 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  if (r.error || r.status !== 0) throw new Error(
    "STORYBOARD_COMMAND_FAILED " + exe + " status=" + r.status +
    " code=" + (r.error?.code ?? "none") + " stderr=" + String(r.stderr).slice(-1400));
  return r.stdout;
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

async function requirePrivateDirectory(dir) {
  const info = await lstat(dir);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(await realpath(dir), dir);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o077, 0);
}

export function verifyStoryboardSourceScope(report, catalog, story) {
  assert.equal(report.status, "PRIVATE_ASSET_CONTACT_REVIEW_REQUIRED");
  assert.equal(report.publicationAllowed, false);
  assert.equal(report.realMediaRenderApproved, false);
  assert.equal(report.assetCount, 5);
  assert.equal(report.assets?.length, 5);
  assert.equal(catalog.status, "INSPECTED_UNAPPROVED");
  assert.ok(catalog.candidates.every(x =>
    x.rightsApproved === false && x.editorialApproved === false &&
    x.thirdPartyRightsCleared === false));
  assert.equal(story.visualDesignVersion, 2);
  assert.equal(story.beats.length, 6);
  const candidates = new Map(catalog.candidates.map(x => [x.id, x]));
  const assets = new Map(report.assets.map(x => [x.candidateId, x]));
  assert.equal(assets.size, 5);
  for (const [id, candidate] of candidates) {
    const asset = assets.get(id);
    assert.ok(asset && asset.role === candidate.role);
    assert.ok(asset.originalSha256 && /^[a-f0-9]{64}$/.test(asset.originalSha256));
    assert.equal(asset.rightsReview?.approvalStatus, "INSPECTED_UNAPPROVED");
    assert.equal(asset.rightsReview?.publicationAllowed, false);
    assert.equal(asset.rightsReview?.specificReuseRightsConfirmed, false);
    assert.equal(asset.rightsReview?.thirdPartyRightsCleared, false);
    assert.ok(Array.isArray(asset.framesSampled));
    assert.equal(asset.framesSampled.length, candidate.type === "photo" ? 1 : 3);
  }
  assert.equal(story.beats[3].visual.scienceRole, "science-inset");
  assert.equal(story.beats[4].visual.scienceRole, "image-card");
  assert.equal(STORYBOARD_ASSIGNMENTS.length, 6);
  for (const [index, assignment] of STORYBOARD_ASSIGNMENTS.entries()) {
    assert.equal(assignment.beat, index + 1);
    assert.ok(assets.has(assignment.background));
    const media = assignment.media ? assets.get(assignment.media) : null;
    assert.ok(!media || media.role === story.beats[index].visual.scienceRole,
      "Science-card source must match the scene's specific science role");
    if (media) assert.equal(story.beats[index].visual.presentation, "science-stage");
  }
  return assets;
}

export function privateStoryboardStampSvg() {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">',
    '<rect x="17" y="15" width="278" height="33" rx="6" ' +
      'fill="#04111f" fill-opacity=".88"/>',
    '<text x="30" y="37" fill="#ffd2b8" font-size="15" ' +
      'font-family="DejaVu Sans,sans-serif" font-weight="700">' +
      'UNAPPROVED · PRIVATE STORYBOARD</text>',
    '</svg>',
  ].join("");
}

export async function rasterize(dir, name, svg) {
  const source = join(dir, name + ".svg");
  const output = join(dir, name + ".png");
  await writeFile(source, svg, {mode: 0o600, flag: "wx"});
  command("rsvg-convert", ["--output", output, source], 30000);
  assert.ok((await stat(output)).size > 1000);
  return output;
}

export function storyboardRenderGraph(hasMedia, placement = null) {
  const graph = [
    "[0:v]scale=1280:720:force_original_aspect_ratio=increase," +
      "crop=1280:720,setsar=1,format=rgba[bg]",
    "[bg][1:v]overlay=0:0:format=auto[dimmed]",
  ];
  let last = "[dimmed]", graphicIndex = 2;
  if (hasMedia) {
    assert.ok(placement && placement.width >= 700 && placement.height >= 400);
    graph.push("[2:v]scale=" + placement.width + ":" + placement.height +
      ":force_original_aspect_ratio=decrease," +
      "pad=" + placement.width + ":" + placement.height +
      ":(ow-iw)/2:(oh-ih)/2:color=0x06101b,format=rgba[source-media]");
    graph.push("[dimmed][source-media]overlay=" +
      placement.x + ":" + placement.y + ":format=auto[science]");
    last = "[science]";
    graphicIndex = 3;
  }
  graph.push(last + "[" + graphicIndex +
    ":v]overlay=0:0:format=auto[with-text]");
  graph.push("[with-text][" + (graphicIndex + 1) +
    ":v]overlay=0:0:format=auto,format=rgb24[out]");
  return graph.join(";");
}

export async function renderFrame({background, dim, media, placement, editorial, stamp, output}) {
  const all = [background, dim, ...(media ? [media] : []), editorial, stamp];
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-threads", "1", "-filter_complex_threads", "1",
    ...all.flatMap(path => [
      "-loop", "1", "-framerate", "1",
      "-protocol_whitelist", "file,pipe", "-i", path,
    ]),
    "-filter_complex", storyboardRenderGraph(Boolean(media), placement),
    "-map", "[out]", "-frames:v", "1", "-update", "1",
    "-c:v", "png", output,
  ];
  command("ffmpeg", args);
  assert.ok((await stat(output)).size > 8000, "Missing composited image");
  const info = JSON.parse(command("ffprobe", [
    "-v", "error", "-show_entries",
    "stream=codec_name,codec_type,width,height",
    "-of", "json", output,
  ], 10000));
  assert.equal(info.streams[0].codec_name, "png");
  assert.equal(info.streams[0].width, 1280);
  assert.equal(info.streams[0].height, 720);
}

async function savePrivateStoryboard() {
  assert.ok(process.env.CI !== "true" &&
    process.env.GITHUB_ACTIONS !== "true" &&
    process.env.VNS_VPS_PREVIEW_APPROVED === "PRIVATE_REVIEW_ONLY" &&
    typeof process.getuid === "function" && process.getuid() === 1000 &&
    userInfo().username === "ap",
  "Private storyboard must be explicitly approved on ap's VPS only");

  await requirePrivateDirectory(ROOT);
  await requirePrivateDirectory(AUDIT);
  const reportPath = join(AUDIT, "source-audit-receipt.json");
  const reportInfo = await lstat(reportPath);
  assert.ok(reportInfo.isFile() && !reportInfo.isSymbolicLink() &&
    reportInfo.size > 1000 && reportInfo.size < 256 * 1024);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const {story, catalog} = await loadOzonePilot();
  const assets = verifyStoryboardSourceScope(report, catalog, story);
  const sourceInfo = await lstat(SOURCE_MANIFEST);
  assert.ok(sourceInfo.isFile() && !sourceInfo.isSymbolicLink());
  const sourceManifest = JSON.parse(await readFile(SOURCE_MANIFEST, "utf8"));
  assert.equal(sourceManifest.status, "INSPECTED_UNAPPROVED");
  assert.equal(sourceManifest.privateUseScope, "DRAFT_UNAPPROVED");
  assert.equal(sourceManifest.publicationAllowed, false);
  assert.ok(sourceManifest.assets.every(x =>
    x.rightsApproved === false &&
    x.editorialApproved === false &&
    x.thirdPartyRightsCleared === false));
  assert.equal(await sha256(SOURCE_MANIFEST), report.sourceIntakeManifestSha256,
    "Audit source intake manifest changed since inspection");
  for (const a of report.assets) {
    assert.equal(await sha256(a.originalPath), a.originalSha256,
      "Private source media bytes changed since NASA contact audit");
    for (const contact of a.framesSampled) {
      const path = join(AUDIT, contact.name);
      assert.equal(await sha256(path), contact.sha256,
        "NASA contact JPEG changed since original audit");
    }
  }

  let created = false;
  try {
    // Exclusively new private output. Never overwrite or remove any existing
    // original-media evidence or operator-created study.
    await mkdir(TARGET, {mode: 0o700});
    created = true;
    const dim = await rasterize(TARGET, "translucent-gradient",
      createLayeredDimSvg());
    const stamp = await rasterize(TARGET, "unapproved-review-stamp",
      privateStoryboardStampSvg());
    const frames = [];
    for (const assignment of STORYBOARD_ASSIGNMENTS) {
      const beat = story.beats[assignment.beat - 1];
      const background = assets.get(assignment.background);
      const backgroundContact = background.framesSampled[assignment.frame - 1];
      assert.ok(backgroundContact, "Missing audited background contact frame");
      const scientificAsset = assignment.media ? assets.get(assignment.media) : null;
      const scientificContact = scientificAsset
        ? scientificAsset.framesSampled[assignment.mediaFrame - 1] : null;
      if (scientificAsset) assert.ok(scientificContact);
      const mediaSource = scientificAsset ? catalog.candidates.find(
        candidate => candidate.id === scientificAsset.candidateId) : null;
      const svg = createMinuteEditorialOverlaySvg({
        visual: beat.visual, sequence: assignment.beat,
        backgroundCredit: catalog.candidates.find(x =>
          x.id === assignment.background)?.credit ?? "NASA source under review",
        foreground: mediaSource ? {
          role: scientificAsset.role, credit: mediaSource.credit,
        } : null,
      });
      const art = await rasterize(TARGET, "editorial-" +
        String(assignment.beat).padStart(2, "0"), svg);
      const name = "storyboard-beat-" + String(assignment.beat).padStart(2, "0") + ".png";
      const output = join(TARGET, name);
      await renderFrame({
        background: join(AUDIT, backgroundContact.name),
        dim,
        media: scientificContact ? join(AUDIT, scientificContact.name) : null,
        placement: scientificContact
          ? minuteMediaPlacement(beat.visual.presentation) : null,
        editorial: art, stamp, output,
      });
      frames.push({
        name, sceneId: beat.id, narration: beat.narration,
        backgroundCandidateId: assignment.background,
        backgroundContact: backgroundContact.name,
        sourceCandidateId: scientificAsset?.candidateId ?? null,
        sourceContact: scientificContact?.name ?? null,
        sha256: await sha256(output),
      });
    }
    const sheet = "p3-18-centered-visual-storyboard.jpg";
    command("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-framerate", "1", "-start_number", "1",
      "-i", join(TARGET, "storyboard-beat-%02d.png"),
      "-vf", "scale=640:360,tile=2x3:nb_frames=6:padding=6:margin=8:color=0x091624",
      "-frames:v", "1", "-update", "1", "-q:v", "3",
      join(TARGET, sheet),
    ]);
    assert.ok((await stat(join(TARGET, sheet))).size > 15000);
    const receipt = {
      schemaVersion: 2,
      status: "UNAPPROVED_REAL_NASA_STILL_STORYBOARD_ONLY",
      publicationAllowed: false,
      realMediaRenderApproved: false,
      humanVisualApproval: false,
      audioGenerated: false,
      actualNASAAnimationVideoRendered: false,
      movingVideoOutputCreated: false,
      actualMediaSourceIntakeUnapproved: true,
      originalAuditSha256: await sha256(reportPath),
      originalIntakeSha256: report.sourceIntakeManifestSha256,
      originalNASAAssetsPreserved: true,
      storyVersion: story.visualDesignVersion,
      sheet: {name: sheet, sha256: await sha256(join(TARGET, sheet))},
      frames,
    };
    await writeFile(join(TARGET, "storyboard-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n", {mode: 0o600, flag: "wx"});
    console.log("P3_18_CENTERED_STORYBOARD=" + join(TARGET, sheet));
    console.log("P3_18_STORYBOARD_RECEIPT=" + join(TARGET, "storyboard-receipt.json"));
    console.log("SCENES=6; NASA_CONTACT_STILLS_ONLY=YES");
    console.log("REAL_MEDIA_MOVIE_ALLOWED=NO; PUBLICATION_ALLOWED=NO");
  } catch (error) {
    if (created) await rm(TARGET, {recursive: true, force: true});
    throw error;
  }
}

const invoked = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  assert.equal(process.argv.length, 3);
  assert.equal(process.argv[2], "--save-private");
  await savePrivateStoryboard();
}
