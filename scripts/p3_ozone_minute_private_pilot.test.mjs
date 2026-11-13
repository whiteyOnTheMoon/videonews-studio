import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createLayeredForegroundSvg, encodeLayeredSequence,
  planLayeredTimeline} from "./p3_layered_cinematic_composition.mjs";
import {loadOzonePilot, requirePilotMediaScope} from "./p3_ozone_minute_private_pilot.mjs";
import {makeUnapprovedInventory} from "./p3_18_create_media_draft.mjs";

function cmd(name, args, encoding = "utf8", timeout = 260000) {
  const p = spawnSync(name, args, {
    encoding, timeout, maxBuffer: 1024 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(p.status, 0, name + " " + String(p.stderr ?? "").slice(-1200));
  return p.stdout;
}
const sha = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const probe = file => JSON.parse(cmd("ffprobe", [
  "-v", "error",
  "-show_entries", "format=duration:stream=codec_name,codec_type,nb_frames,width,height",
  "-of", "json", file,
]));

test("the real editorial plan is factual, centrally laid out, and permanently publication-blocked", async () => {
  const {story, catalog, words} = await loadOzonePilot();
  assert.equal(story.durationFrames, 1440);
  assert.equal(story.beats.length, 6);
  assert.ok(words >= 105 && words <= 140);
  assert.equal(story.publicationAllowed, false);
  assert.ok(story.sources.every(x => x.url.startsWith("https://")));
  assert.ok(story.beats[1].narration.includes("twenty-five million"));
  assert.ok(story.beats[2].narration.includes("twenty-seven point one"));
  assert.ok(story.beats[5].narration.includes("Montreal Protocol"));
  assert.ok(catalog.candidates.every(x => x.rightsApproved === false));
  assert.ok(catalog.candidates.some(x => x.id === "nasa-ozone-video-2026" &&
    x.expectedSha256 === "adfd7a539766cb06c71e6bdf3fd87d9c646c0d8e4f11913cb5922cd8a46289bb"));
  const metric = createLayeredForegroundSvg({
    visual: story.beats[1].visual, sequence: 2,
    backgroundCredit: "Original synthetic moving Earth",
    foreground: null,
  });
  assert.match(metric, /x="640" y="381"/);
  assert.match(metric, /25 MILLION km²/);
  assert.match(metric, /text-anchor="middle"/);
  const hero = createLayeredForegroundSvg({
    visual: story.beats[0].visual, sequence: 1,
    backgroundCredit: "Original synthetic moving Earth", foreground: null,
  });
  assert.match(hero, /x="210" y="216"/);
  assert.doesNotMatch(hero, /x="68" y="172"/);
  const science = createLayeredForegroundSvg({
    visual: story.beats[3].visual, sequence: 4,
    backgroundCredit: "Synthetically produced background",
    foreground: {credit: "Original synthetic source map"},
  });
  assert.match(science, /x="268" y="220" width="744" height="429"/);
  assert.match(science, /fill="none"/);

  const draft = makeUnapprovedInventory({
    root: "/home/ap/ci-private-only",
    catalog,
    files: Object.fromEntries(catalog.candidates.map(item => [
      item.id, {
        path: "/home/ap/ci-private-only/" + item.id + ".mp4",
        sha256: item.expectedSha256 ?? "1".repeat(64),
      },
    ])),
  });
  assert.equal(draft.privateUseScope, "DRAFT_UNAPPROVED");
  assert.equal(draft.status, "INSPECTED_UNAPPROVED");
  assert.ok(draft.assets.every(x =>
    x.rightsApproved === false && x.editorialApproved === false &&
    x.thirdPartyRightsCleared === false));
  assert.throws(() => requirePilotMediaScope(draft, catalog), /human-reviewed/);

  const fake = {
    schemaVersion: 1,
    privateUseScope: "P3_18_MANUALLY_APPROVED_EDITORIAL_TEST",
    assets: catalog.candidates.map(item => ({
      candidateId: item.id, role: item.role,
      sceneId: item.sceneId, endSceneId: item.endSceneId,
      kind: item.type, compositionMode: "layered-cinematic",
      scientificVisualization: item.role === "science-inset",
      sourceUrl: item.sourcePage, sha256: item.expectedSha256 ?? "0".repeat(64),
      atmosphericVisualReview: true,
      contentClassification: "ILLUSTRATIVE_BACKGROUND",
      captureDate: "2026-10-04",
      sourceDateEvidence: "CI fake date field for negative approval gate only",
      rightsApproved: false, editorialApproved: false,
      thirdPartyRightsCleared: false, licenseEvidence: "PENDING REVIEW",
      rightsReviewedBy: "PENDING", reviewReceipt: "PENDING",
    })),
  };
  assert.throws(() => requirePilotMediaScope(fake, catalog), /not individually approved/);
  assert.throws(() => requirePilotMediaScope({
    ...fake, privateUseScope: "ANYTHING",
  }, catalog), /human-reviewed/);
  assert.throws(() => requirePilotMediaScope({
    ...fake, assets: fake.assets.map(x => ({
      ...x, atmosphericVisualReview: false,
    })),
  }, catalog), /visual-review opt-in/);
  assert.throws(() => requirePilotMediaScope({
    ...fake, assets: fake.assets.map(x => ({...x, rightsApproved: true,
      editorialApproved: true, thirdPartyRightsCleared: true})),
  }, catalog), /evidence note/);
});

test("60-second original synthetic documentary layout encodes 3 motion sources and foreground media", {
  timeout: 300000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "p3-18-minute-"));
  try {
    const {story} = await loadOzonePilot();
    const candidates = [
      {id: "bg-1", role: "background", start: 1, end: 2, color: "0x122fd5", seconds: 21, kind: "video"},
      {id: "bg-2", role: "background", start: 3, end: 4, color: "0x1eaac0", seconds: 21, kind: "video"},
      {id: "bg-3", role: "background", start: 5, end: 6, color: "0xd17c20", seconds: 21, kind: "video"},
      {id: "photo-map", role: "image-card", start: 4, end: 4, color: "0x7bd04a", kind: "photo"},
      {id: "scientific-motion", role: "science-inset", start: 6, end: 6, color: "0x00ee46", seconds: 11, kind: "video"},
    ];
    const assets = [];
    for (const c of candidates) {
      const path = join(root, c.id + (c.kind === "photo" ? ".jpg" : ".mp4"));
      if (c.kind === "photo") {
        cmd("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-f", "lavfi", "-i", "color=c=" + c.color + ":s=960x540:r=24",
          "-frames:v", "1", "-q:v", "3", path]);
      } else {
        cmd("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-f", "lavfi", "-i", "color=c=" + c.color + ":s=960x540:r=24",
          "-f", "lavfi", "-i", "sine=frequency=815:sample_rate=48000",
          "-t", String(c.seconds), "-c:v", "libx264", "-preset",
          "ultrafast", "-crf", "32", "-threads:v", "1",
          "-pix_fmt", "yuv420p", "-c:a", "aac", path]);
      }
      assets.push({
        id: c.id, motifId: "CI_ORIGINAL_" + c.id,
        role: c.role, kind: c.kind, path, sha256: await sha(path),
        sceneId: "beat-" + String(c.start).padStart(2, "0"),
        endSceneId: "beat-" + String(c.end).padStart(2, "0"),
        compositionMode: "layered-cinematic",
        scientificVisualization: c.role === "science-inset",
        sourceUrl: "https://example.org/ci-generated/" + c.id,
        creator: "Original local CI generator",
        credit: "CI ORIGINAL synthetic visual " + c.id,
        captureDate: "2026-11-13", licenseUrl: "https://example.org/ci-generated",
        licenseEvidence: "This file was generated in this test, not obtained from a media provider",
        rightsReviewedBy: "ci-synthetic-fixture-only",
        rightsReviewedAt: "2026-11-13",
        rightsApproved: true, editorialApproved: true, thirdPartyRightsCleared: true,
      });
    }
    const input = {manifest: {schemaVersion: 1, assets}, assetRoot: root,
      beatFrames: Array(6).fill(240), beatVisuals: story.beats.map(b => b.visual)};
    const plan = await planLayeredTimeline(input);
    assert.equal(plan.timelineFrames, 1440);
    assert.deepEqual(plan.backgrounds.map(b => b.sourceFrames), [486, 492, 486]);
    assert.equal(plan.foreground.length, 2);
    await assert.rejects(() => planLayeredTimeline({
      ...input, manifest: {schemaVersion: 1, assets: assets.map((a, index) =>
        index === 4 ? {...a, editorialApproved: false} : a)},
    }), /Unapproved media/);
    await assert.rejects(() => planLayeredTimeline({
      ...input, manifest: {schemaVersion: 1, assets: assets.map((a, index) =>
        index === 1 ? {...a, sha256: "0".repeat(64)} : a)},
    }), /Digest mismatch/);
    const output = join(root, "60-second-synthetic-video.mp4");
    await encodeLayeredSequence({plan, output, directory: join(root, "layers")});
    const info = probe(output);
    assert.equal(info.streams.length, 1);
    assert.equal(info.streams[0].codec_name, "h264");
    assert.equal(Number(info.streams[0].nb_frames), 1440);
    assert.equal(info.streams[0].width, 1280);
    assert.equal(info.streams[0].height, 720);
    assert.ok(Math.abs(Number(info.format.duration) - 60) < .08);
    assert.ok((await stat(output)).size > 120000);

    // Audio from any atmospheric/scientific source is never imported.
    const voice = join(root, "standin-voice.wav");
    cmd("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "60", "-c:a", "pcm_s16le", voice]);
    const muxed = join(root, "60-second-standin-private.mp4");
    cmd("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", output, "-i", voice,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart", muxed]);
    const streams = probe(muxed).streams;
    assert.equal(streams.length, 2);
    assert.equal(streams.find(s => s.codec_type === "audio").codec_name, "aac");
    assert.equal(Number(streams.find(s => s.codec_type === "video").nb_frames), 1440);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
