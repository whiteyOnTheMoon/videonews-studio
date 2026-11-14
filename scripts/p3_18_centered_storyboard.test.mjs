import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  STORYBOARD_ASSIGNMENTS,
  privateStoryboardStampSvg,
  rasterize,
  renderFrame,
  storyboardRenderGraph,
  verifyStoryboardSourceScope,
} from "./p3_18_centered_storyboard.mjs";
import {createLayeredDimSvg} from "./p3_layered_cinematic_composition.mjs";
import {
  createMinuteEditorialOverlaySvg, minuteMediaPlacement,
} from "./p3_minute_editorial_layout.mjs";
import {loadOzonePilot} from "./p3_ozone_minute_private_pilot.mjs";

function cmd(name, args, encoding = "utf8") {
  const r = spawnSync(name, args, {
    encoding, timeout: 40000, maxBuffer: 512 * 1024,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(r.status, 0, name + ": " + String(r.stderr).slice(-900));
  return r.stdout;
}

async function fixture(path, color) {
  cmd("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi", "-i", "color=c=" + color + ":s=960x540:r=24",
    "-frames:v", "1", "-q:v", "3", path,
  ]);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function pixel(path) {
  const result = cmd("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", path,
    "-vf", "format=rgb24,crop=1:1:640:360:exact=1",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], null);
  assert.equal(result.length, 3);
  return [...result];
}

test("visual plan sequences distinct, independently colored scientific sources", async () => {
  const {story, catalog} = await loadOzonePilot();
  assert.equal(story.visualDesignVersion, 2);
  assert.equal(STORYBOARD_ASSIGNMENTS.length, 6);
  assert.deepEqual(STORYBOARD_ASSIGNMENTS.filter(x => x.media).map(x => ({
    beat: x.beat, media: x.media,
  })), [
    {beat: 4, media: "nasa-ozone-video-2026"},
    {beat: 5, media: "nasa-ozone-map-2026"},
  ]);
  assert.deepEqual(
    STORYBOARD_ASSIGNMENTS.map(x => x.background),
    ["svs-earth-5570", "svs-earth-5570",
      "svs-earth-spheres-31365", "svs-earth-spheres-31365",
      "svs-earth-spheres-31365", "svs-pace-31365"]);
  assert.ok(story.beats[3].visual.paletteNote.includes("SOURCE PALETTE"));
  assert.ok(story.beats[4].visual.paletteNote.includes("DOBSON UNITS"));
  assert.ok(story.beats[4].visual.paletteNote.includes("RED = LOWER OZONE"));
  assert.equal(story.publicationAllowed, false);
  assert.ok(catalog.candidates.every(x => !x.rightsApproved));

  const fake = {
    status: "PRIVATE_ASSET_CONTACT_REVIEW_REQUIRED",
    publicationAllowed: false,
    realMediaRenderApproved: false,
    assetCount: 5,
    assets: catalog.candidates.map(x => ({
      candidateId: x.id, role: x.role, originalSha256: "a".repeat(64),
      rightsReview: {
        approvalStatus: "INSPECTED_UNAPPROVED",
        publicationAllowed: false,
        specificReuseRightsConfirmed: false,
        thirdPartyRightsCleared: false,
      },
      framesSampled: Array.from({
        length: x.type === "photo" ? 1 : 3,
      }, (_, i) => ({
        name: x.id + "-frame-0" + (i + 1) + ".jpg",
        sha256: "b".repeat(64),
      })),
    })),
  };
  assert.equal(verifyStoryboardSourceScope(fake, catalog, story).size, 5);
  assert.throws(() => verifyStoryboardSourceScope({
    ...fake, realMediaRenderApproved: true,
  }, catalog, story));
  assert.throws(() => verifyStoryboardSourceScope({
    ...fake, assets: fake.assets.map(x =>
      x.candidateId === "nasa-ozone-map-2026" ? {
        ...x, rightsReview: {...x.rightsReview,
          specificReuseRightsConfirmed: true},
      } : x),
  }, catalog, story));
  assert.throws(() => verifyStoryboardSourceScope(fake, {
    ...catalog, candidates: catalog.candidates.map(x =>
      x.id === "nasa-ozone-video-2026" ? {...x, rightsApproved: true} : x),
  }, story));
  assert.match(privateStoryboardStampSvg(), /UNAPPROVED/);
});

test("actual still-only FFmpeg science stage stays bright and complete above gradient", {
  timeout: 75000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "p3-18-science-stage-"));
  try {
    const {story} = await loadOzonePilot();
    const bg = join(root, "background.jpg");
    const science = join(root, "ozone-animated-contact.jpg");
    const map = join(root, "dobson-source-contact.jpg");
    const bgSha = await fixture(bg, "0x13249c");
    const sciSha = await fixture(science, "0x00ee46");
    const mapSha = await fixture(map, "0xf04020");
    const dim = await rasterize(root, "dim", createLayeredDimSvg());
    const stamp = await rasterize(root, "stamp", privateStoryboardStampSvg());
    const stage = minuteMediaPlacement("science-stage");
    assert.deepEqual(stage, {x: 96, y: 82, width: 1088, height: 612});
    assert.match(storyboardRenderGraph(true, stage), /overlay=96:82/);
    assert.doesNotMatch(storyboardRenderGraph(false), /source-media/);
    for (const [index, media, role, expected] of [
      [3, science, "science-inset", "green"],
      [4, map, "image-card", "red"],
    ]) {
      const art = createMinuteEditorialOverlaySvg({
        visual: story.beats[index].visual,
        sequence: index + 1,
        backgroundCredit: "Private synthetic sky",
        foreground: {role, credit: "Private CI synthetic science"},
      });
      const image = await rasterize(root, "editorial" + index, art);
      const output = join(root, "frame" + index + ".png");
      await renderFrame({background: bg, dim, media, placement: stage,
        editorial: image, stamp, output});
      assert.ok((await stat(output)).size > 6000);
      const rgb = pixel(output);
      if (expected === "green") assert.ok(rgb[1] > rgb[0] + 105 &&
        rgb[1] > rgb[2] + 75, "Science motion was dimmed: " + rgb);
      else assert.ok(rgb[0] > rgb[1] + 100 &&
        rgb[0] > rgb[2] + 105, "Dobson map was dimmed: " + rgb);
    }
    for (const [path, before] of [[bg, bgSha], [science, sciSha], [map, mapSha]])
      assert.equal(createHash("sha256").update(await readFile(path)).digest("hex"),
        before, "Storyboarding must never mutate a source");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
