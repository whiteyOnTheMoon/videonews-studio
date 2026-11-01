import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
import { join } from "node:path";
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
