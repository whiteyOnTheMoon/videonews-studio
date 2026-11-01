import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSource, preflight, stageOnce, verifyStage } from "./p2_01_signed_handoff_stage.mjs";

const enabled = process.getuid?.() === 0;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vns-p2-stage-"));
  const parent = join(root, "videonews-studio");
  mkdirSync(parent, { mode: 0o700 });
  const base = join(parent, "p2-signed-source");
  mkdirSync(base, { mode: 0o700 });
  const p = (part) => join(base, part);
  for (const [part, uid, gid] of [
    ["publisher", 10001, 10001],
    ["trust-material", 0, 0],
    ["worker-inbox", 10002, 10002],
    ["worker-checkpoint", 10002, 10002],
  ]) {
    mkdirSync(p(part), { mode: 0o700 });
    chownSync(p(part), uid, gid);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const registryJson = JSON.stringify({ version: 1, sources: [] });
  const body = {
    version: 1,
    sourceRevision: 8,
    hostApprovalRevision: 7,
    allowedHosts: ["www.noaa.gov"],
    registryJson,
  };
  const exported = {
    ...body,
    sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
  const signature = sign(
    null,
    Buffer.from("VNS source export signature v1\0" + JSON.stringify(exported)),
    privateKey,
  ).toString("base64url");
  const original = JSON.stringify({
    format: "vns-source-export-ed25519-v1",
    export: exported,
    signature,
  });
  writeFileSync(p("publisher/source-export.signed.json"), original, { mode: 0o600 });
  chownSync(p("publisher/source-export.signed.json"), 10001, 10001);
  writeFileSync(
    p("trust-material/signing-public.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o440 },
  );
  chownSync(p("trust-material/signing-public.pem"), 0, 10002);
  chmodSync(p("trust-material/signing-public.pem"), 0o440);
  return {
    root,
    base,
    p,
    original,
    cfg: { parent, base, user: { publisher: 10001, worker: 10002, transfer: 10003 } },
  };
}
test(
  "one-shot staging verifies signature, ownership and exact unchanged bytes",
  { skip: !enabled },
  () => {
    const f = fixture();
    try {
      assert.equal(inspectSource(f.cfg).toString("utf8"), f.original);
      preflight(f.cfg);
      stageOnce(f.cfg);
      verifyStage(f.cfg);
      assert.equal(
        readFileSync(f.p("handoff-staging/source-export.signed.json"), "utf8"),
        f.original,
      );
      const dir = statSync(f.p("handoff-staging"));
      const file = statSync(f.p("handoff-staging/source-export.signed.json"));
      assert.deepEqual([dir.uid, dir.gid, dir.mode & 0o777], [10003, 10002, 0o750]);
      assert.deepEqual([file.uid, file.gid, file.mode & 0o777], [10003, 10002, 0o640]);
      assert.throws(() => stageOnce(f.cfg));
      verifyStage(f.cfg);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
test("rejects untrusted public key and changed stage bytes", { skip: !enabled }, () => {
  const f = fixture();
  try {
    const other = generateKeyPairSync("ed25519").publicKey;
    writeFileSync(
      f.p("trust-material/signing-public.pem"),
      other.export({ type: "spki", format: "pem" }),
    );
    assert.throws(() => preflight(f.cfg));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
  const g = fixture();
  try {
    stageOnce(g.cfg);
    writeFileSync(g.p("handoff-staging/source-export.signed.json"), "tampered");
    assert.throws(() => verifyStage(g.cfg));
  } finally {
    rmSync(g.root, { recursive: true, force: true });
  }
});
test("refuses nonempty worker checkpoint before staging", { skip: !enabled }, () => {
  const f = fixture();
  try {
    writeFileSync(f.p("worker-checkpoint/source-export.checkpoint.json"), "{}");
    assert.throws(() => preflight(f.cfg));
    assert.throws(() => stageOnce(f.cfg));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("relative and absolute CLI calls must execute and refuse an invalid release", () => {
  const script = fileURLToPath(new URL("./p2_01_signed_handoff_stage.mjs", import.meta.url));
  const cwd = dirname(dirname(script));
  const args = ["--preflight", "--expected-sha", "0".repeat(40)];
  for (const executable of ["scripts/p2_01_signed_handoff_stage.mjs", script]) {
    const processResult = spawnSync(process.execPath, [executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(processResult.status, 2, executable);
    assert.match(processResult.stderr, /REFUSED: signed source staging unsafe/);
    assert.doesNotMatch(processResult.stdout, /PASS:/);
  }
});


test("real worker UID can read staged bytes but cannot edit stage or access publisher", { skip: !enabled }, () => {
  const f = fixture();
  try {
    stageOnce(f.cfg);
    const probe = `
      const fs = require("node:fs");
      process.setgid(10002);
      process.setuid(10002);
      const data = fs.readFileSync("./source-export.signed.json");
      if (!data.includes(Buffer.from("vns-source-export-ed25519-v1"))) process.exit(9);
      for (const path of [
        "../publisher/source-export.signed.json",
        "./not-allowed-write-test"
      ]) {
        try {
          if (path.includes("not-allowed")) {
            fs.writeFileSync(path, "must refuse", { flag: "wx" });
          } else {
            fs.readFileSync(path);
          }
          process.exit(10);
        } catch (error) {
          if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
        }
      }
      try {
        fs.openSync("./source-export.signed.json", "r+");
        process.exit(11);
      } catch (error) {
        if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
      }
    `;
    const result = spawnSync(process.execPath, ["-e", probe], {
      cwd: f.p("handoff-staging"),
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr || "UID isolation failed");
    verifyStage(f.cfg);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
