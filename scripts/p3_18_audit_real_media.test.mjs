import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  auditSampleSeconds, createUnapprovedReviewChecklist, makeReviewFrame,
} from "./p3_18_audit_real_media.mjs";

function command(name, args) {
  const p = spawnSync(name, args, {
    encoding: "utf8", timeout: 40000,
    env: {PATH: process.env.PATH ?? "/usr/bin:/bin"},
  });
  assert.equal(p.status, 0, name + ": " + String(p.stderr).slice(-600));
  return p.stdout;
}

test("NASA-specific private audit preserves unapproved status and exact sample times", () => {
  assert.deepEqual(auditSampleSeconds("nasa-ozone-video-2026", 15.166667),
    [1, 7, 14]);
  assert.deepEqual(auditSampleSeconds("svs-earth-5570", 100), [1, 10, 20]);
  assert.deepEqual(auditSampleSeconds("svs-earth-spheres-31365", 54),
    [1, 10, 20]);
  assert.deepEqual(auditSampleSeconds("svs-pace-31365", 30), [1, 10, 20]);
  assert.throws(() => auditSampleSeconds("svs-earth-spheres-31365", 8),
    /shorter/);
  assert.throws(() => auditSampleSeconds("nasa-ozone-video-2026", 13),
    /shorter/);
  assert.throws(() => auditSampleSeconds("unknown", 100));
  const fields = createUnapprovedReviewChecklist({
    id: "svs-earth-spheres-31365",
    sourcePage: "https://svs.gsfc.nasa.gov/31365/",
    fileUrl: "https://svs.gsfc.nasa.gov/vis/fixture.mp4",
    rightsApproved: false,
    editorialApproved: false,
    thirdPartyRightsCleared: false,
  });
  assert.equal(fields.approvalStatus, "INSPECTED_UNAPPROVED");
  assert.equal(fields.specificReuseRightsConfirmed, false);
  assert.equal(fields.thirdPartyRightsCleared, false);
  assert.equal(fields.publicationAllowed, false);
  assert.match(fields.creditToVerify, /Marit Jentoft-Nilsen/);
  assert.match(fields.datasetDateWarning, /27 seconds/);
  const ozone = createUnapprovedReviewChecklist({
    id: "nasa-ozone-video-2026",
    sourcePage: "https://ozonewatch.gsfc.nasa.gov/SH.html",
    fileUrl: null,
    rightsApproved: false,
    editorialApproved: false,
    thirdPartyRightsCleared: false,
  });
  assert.equal(ozone.sourceFileUrl, null);
  assert.ok(ozone.manualChecks.some(x => x.includes("legend")));
  assert.throws(() => createUnapprovedReviewChecklist({
    id: "svs-earth-5570", rightsApproved: true,
    editorialApproved: false, thirdPartyRightsCleared: false,
  }), /never accepts approved/);
});

test("locally generated sample frame is fitted, hashed and source video unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "p3-18-media-audit-fixture-"));
  try {
    const source = join(root, "synthetic-source-with-audio.mp4");
    const frame = join(root, "synthetic-contact.jpg");
    command("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=24",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "3", "-c:v", "libx264", "-preset", "ultrafast",
      "-crf", "32", "-threads:v", "1", "-pix_fmt", "yuv420p",
      "-c:a", "aac", source,
    ]);
    const original = createHash("sha256").update(await readFile(source)).digest("hex");
    await makeReviewFrame(source, frame, 1);
    assert.ok((await stat(frame)).size > 1000);
    assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"),
      original, "Auditor must never alter original video bytes");
    const meta = JSON.parse(command("ffprobe", [
      "-v", "error", "-show_entries", "stream=width,height,codec_type",
      "-of", "json", frame,
    ]));
    assert.equal(meta.streams.length, 1);
    assert.equal(meta.streams[0].width, 960);
    assert.equal(meta.streams[0].height, 540);
    assert.equal(meta.streams[0].codec_type, "video");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
