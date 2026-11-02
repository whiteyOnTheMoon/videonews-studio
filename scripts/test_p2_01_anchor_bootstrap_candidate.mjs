import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stageOnce } from "./p2_01_signed_handoff_stage.mjs";
import { buildAnchorBootstrapCandidate } from "./p2_01_anchor_bootstrap_candidate.mjs";
import { calculateTrustPolicyManifest } from "./p2_01_pinned_trust_policy_report.mjs";

const root = process.getuid?.() === 0;

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "vns-anchor-candidate-"));
  const parent = join(temp, "videonews-studio");
  const base = join(parent, "p2-signed-source");
  mkdirSync(parent, { mode: 0o700 });
  mkdirSync(base, { mode: 0o700 });
  const path = (part) => join(base, part);
  for (const [part, uid, gid] of [
    ["publisher", 10001, 10001],
    ["trust-material", 0, 0],
    ["worker-inbox", 10002, 10002],
    ["worker-checkpoint", 10002, 10002],
  ]) {
    mkdirSync(path(part), { mode: 0o700 });
    chownSync(path(part), uid, gid);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    version: 1,
    sourceRevision: 8,
    hostApprovalRevision: 7,
    allowedHosts: ["news.example.org"],
    registryJson: JSON.stringify({ version: 1, sources: [] }),
  };
  const exported = {
    ...payload,
    sha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
  const document = {
    format: "vns-source-export-ed25519-v1",
    export: exported,
    signature: sign(
      null,
      Buffer.from("VNS source export signature v1\0" + JSON.stringify(exported)),
      privateKey,
    ).toString("base64url"),
  };
  const canonical = Buffer.from(JSON.stringify(document));
  writeFileSync(path("publisher/source-export.signed.json"), canonical, { mode: 0o600 });
  chownSync(path("publisher/source-export.signed.json"), 10001, 10001);
  writeFileSync(
    path("trust-material/signing-public.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
    { mode: 0o440 },
  );
  chownSync(path("trust-material/signing-public.pem"), 0, 10002);
  chmodSync(path("trust-material/signing-public.pem"), 0o440);

  const config = { parent, base, user: { publisher: 10001, worker: 10002, transfer: 10003 } };
  stageOnce(config);
  const inboxFile = path("worker-inbox/source-export.signed.json");
  writeFileSync(inboxFile, canonical, { mode: 0o600 });
  chownSync(inboxFile, 10002, 10002);

  return {
    temp,
    path,
    config,
    canonical,
    publicKey,
    inboxFile,
    cleanup: () => rmSync(temp, { recursive: true, force: true }),
  };
}

test(
  "candidate matches canonical signed envelope and independently pinned trust digest",
  {
    skip: !root,
  },
  () => {
    const f = fixture();
    try {
      const candidate = buildAnchorBootstrapCandidate(f.config, 1);
      const trusted = calculateTrustPolicyManifest(f.publicKey, 1);
      assert.equal(candidate.status, "bootstrap_candidate_only");
      assert.equal(candidate.schemaVersion, 1);
      assert.equal(candidate.externalAnchorVerified, false);
      assert.equal(candidate.independentlyApproved, false);
      assert.equal(candidate.checkpointCreated, false);
      assert.equal(candidate.sourceRevision, 8);
      assert.equal(candidate.hostApprovalRevision, 7);
      assert.equal(
        candidate.envelopeSha256,
        createHash("sha256").update(f.canonical).digest("hex"),
      );
      assert.equal(candidate.policySha256, trusted.policySha256);
      assert.equal(candidate.publicKeyFingerprint, trusted.publicKeyFingerprint);
      assert.equal(candidate.sourceEpochStart, 1);
      assert.equal(candidate.hostEpochStart, 1);
      assert.equal(Object.keys(candidate).length, 13);
      assert.doesNotMatch(JSON.stringify(candidate), /news[.]example[.]org|privateKey/);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "candidate refuses missing or altered worker import and unsafe ownership",
  {
    skip: !root,
  },
  () => {
    const f = fixture();
    try {
      unlinkSync(f.inboxFile);
      assert.throws(() => buildAnchorBootstrapCandidate(f.config, 1));
      writeFileSync(f.inboxFile, f.canonical, { mode: 0o600 });
      chownSync(f.inboxFile, 10002, 10002);
      writeFileSync(f.inboxFile, "tampered");
      assert.throws(() => buildAnchorBootstrapCandidate(f.config, 1));
      writeFileSync(f.inboxFile, f.canonical);
      chmodSync(f.inboxFile, 0o644);
      assert.throws(() => buildAnchorBootstrapCandidate(f.config, 1));
      chmodSync(f.inboxFile, 0o600);
      chownSync(f.inboxFile, 0, 0);
      assert.throws(() => buildAnchorBootstrapCandidate(f.config, 1));
      chownSync(f.inboxFile, 10002, 10002);
      assert.equal(buildAnchorBootstrapCandidate(f.config, 1).sourceRevision, 8);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "candidate refuses changed stage, symlinked inbox and existing checkpoint",
  {
    skip: !root,
  },
  () => {
    const f = fixture();
    try {
      writeFileSync(f.path("handoff-staging/source-export.signed.json"), "tampered");
      assert.throws(() => buildAnchorBootstrapCandidate(f.config, 1));
    } finally {
      f.cleanup();
    }
    const g = fixture();
    try {
      unlinkSync(g.inboxFile);
      symlinkSync(g.path("publisher/source-export.signed.json"), g.inboxFile);
      assert.throws(() => buildAnchorBootstrapCandidate(g.config, 1));
    } finally {
      g.cleanup();
    }
    const h = fixture();
    try {
      writeFileSync(h.path("worker-checkpoint/source-export.checkpoint.json"), "{}");
      assert.throws(() => buildAnchorBootstrapCandidate(h.config, 1));
      assert.throws(() => buildAnchorBootstrapCandidate(h.config, 0));
    } finally {
      h.cleanup();
    }
  },
);

test(
  "candidate refuses changed pinned signer and noncanonical envelope",
  {
    skip: !root,
  },
  () => {
    const f = fixture();
    try {
      const { publicKey } = generateKeyPairSync("ed25519");
      writeFileSync(
        f.path("trust-material/signing-public.pem"),
        publicKey.export({ type: "spki", format: "pem" }),
      );
      assert.throws(() => buildAnchorBootstrapCandidate(f.config, 1));
    } finally {
      f.cleanup();
    }
    const g = fixture();
    try {
      const noncanonical = Buffer.from(
        JSON.stringify(JSON.parse(g.canonical.toString("utf8"))).replace('"format":', '"format" :'),
      );
      for (const part of [
        "publisher/source-export.signed.json",
        "handoff-staging/source-export.signed.json",
        "worker-inbox/source-export.signed.json",
      ]) {
        writeFileSync(g.path(part), noncanonical);
      }
      assert.throws(() => buildAnchorBootstrapCandidate(g.config, 1));
    } finally {
      g.cleanup();
    }
  },
);

test("CLI rejects invalid release without emitting candidate digests", () => {
  const script = fileURLToPath(new URL("./p2_01_anchor_bootstrap_candidate.mjs", import.meta.url));
  const cwd = dirname(dirname(script));
  for (const command of ["scripts/p2_01_anchor_bootstrap_candidate.mjs", script]) {
    const result = spawnSync(
      process.execPath,
      [command, "--report", "--expected-sha", "0".repeat(40), "--policy-revision", "1"],
      { cwd, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: independent anchor candidate evidence unavailable/);
    assert.doesNotMatch(result.stdout, /envelopeSha256|policySha256/);
  }
});
