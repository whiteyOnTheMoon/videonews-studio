import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pinnedTrustPolicyDigest } from "../apps/worker/dist/source-trust-policy-anchor.js";
import {
  calculateTrustPolicyManifest,
  parseTrustRevision,
  readPinnedPublicKey,
} from "./p2_01_pinned_trust_policy_report.mjs";

const root = process.getuid?.() === 0 && process.env.CI === "true";

test("operator digest matches exact production worker trust-policy digest", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const computed = calculateTrustPolicyManifest(publicKey, 7);
  assert.equal(computed.policyRevision, 7);
  assert.equal(computed.publicKeyFingerprint.length, 64);
  assert.equal(
    computed.policySha256,
    pinnedTrustPolicyDigest({
      policyRevision: 7,
      rotation: {
        epochs: [{ publicKey, fromSourceRevision: 1, fromHostApprovalRevision: 1 }],
      },
    }),
  );
  assert.equal(Object.keys(computed).length, 5);
});

test("policy revision has no implicit bootstrap or noncanonical input", () => {
  for (const text of ["", "0", "-1", "01", "1.0", "1e2", " 1", "1 ", "9007199254740992"]) {
    assert.throws(() => parseTrustRevision(text));
  }
  assert.equal(parseTrustRevision("1"), 1);
  assert.equal(parseTrustRevision("999999999999999"), 999999999999999);
});

test("root read refuses wrong ownership, mode and symlink material", { skip: !root }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vns-policy-report-"));
  try {
    const path = join(dir, "pinned-public.pem");
    const { publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(path, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o440 });
    chownSync(path, 0, 10002);
    chmodSync(path, 0o440);
    const parsed = readPinnedPublicKey(path);
    assert.equal(
      calculateTrustPolicyManifest(parsed, 1).policySha256,
      calculateTrustPolicyManifest(publicKey, 1).policySha256,
    );
    chmodSync(path, 0o444);
    assert.throws(() => readPinnedPublicKey(path));
    chmodSync(path, 0o440);
    chownSync(path, 10003, 10002);
    assert.throws(() => readPinnedPublicKey(path));
    chownSync(path, 0, 10002);
    const link = join(dir, "symbolic.pem");
    symlinkSync(path, link);
    assert.throws(() => readPinnedPublicKey(link));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relative CLI invocation fails closed before opening the trusted host path", () => {
  const path = fileURLToPath(new URL("./p2_01_pinned_trust_policy_report.mjs", import.meta.url));
  const cwd = dirname(dirname(path));
  for (const invoke of [path, "scripts/p2_01_pinned_trust_policy_report.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [invoke, "--report", "--expected-sha", "0".repeat(40), "--policy-revision", "1"],
      { cwd, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /REFUSED: trusted source policy report unavailable/);
    assert.doesNotMatch(result.stdout, /policySha256/);
  }
});
