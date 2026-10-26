import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { sealDormantSourceExport } from "./source-export-signature.js";
import { prepareDormantSourceExport } from "./source-registry-export.js";
import { signingPublicKeyId, verifyRotatingSourceExport } from "./source-signing-key-rotation.js";

const policy = { enabled: true as const, hosts: ["news.example.org"] };
const source = {
  id: "sample_news", baseUrl: "https://news.example.org/feed/", status: "approved" as const,
  access: "rss" as const, intervalMinutes: 60, termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only" as const, licenseNotes: "Synthetic fixture.", reviewedAt: "2026-10-26",
};
function bundle(revision: number) {
  return prepareDormantSourceExport(
    { revision, sources: [source] },
    { revision, approvedHosts: ["news.example.org"] },
  );
}
const minimum = { sourceRevision: 1, hostApprovalRevision: 1 };

test("explicit nonoverlapping epochs accept only the intended key", () => {
  const oldKey = generateKeyPairSync("ed25519");
  const newKey = generateKeyPairSync("ed25519");
  const rotation = { epochs: [
    { publicKey: oldKey.publicKey, fromSourceRevision: 1, fromHostApprovalRevision: 1,
      untilSourceRevision: 8, untilHostApprovalRevision: 8 },
    { publicKey: newKey.publicKey, fromSourceRevision: 9, fromHostApprovalRevision: 9 },
  ] };
  const oldEnvelope = sealDormantSourceExport(bundle(8), policy, oldKey.privateKey);
  assert.equal(verifyRotatingSourceExport(oldEnvelope, policy, rotation, minimum).keyId,
    signingPublicKeyId(oldKey.publicKey));
  const updated = sealDormantSourceExport(bundle(9), policy, newKey.privateKey);
  assert.equal(verifyRotatingSourceExport(updated, policy, rotation, minimum).keyId,
    signingPublicKeyId(newKey.publicKey));
  assert.throws(() => verifyRotatingSourceExport(
    sealDormantSourceExport(bundle(9), policy, oldKey.privateKey), policy, rotation, minimum,
  ));
  assert.throws(() => verifyRotatingSourceExport(
    sealDormantSourceExport(bundle(8), policy, newKey.privateKey), policy, rotation, minimum,
  ));
});

test("overlap, gaps, duplicate keys and malformed epochs fail closed", () => {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const signed = sealDormantSourceExport(bundle(8), policy, a.privateKey);
  const epoch = { publicKey: a.publicKey, fromSourceRevision: 1, fromHostApprovalRevision: 1 };
  for (const epochs of [
    [],
    [epoch, epoch],
    [epoch, { publicKey: b.publicKey, fromSourceRevision: 2, fromHostApprovalRevision: 2 }],
    [{ publicKey: a.publicKey, fromSourceRevision: 9, fromHostApprovalRevision: 9 }],
    [{ ...epoch, untilSourceRevision: 0 }],
  ]) {
    assert.throws(() => verifyRotatingSourceExport(signed, policy, { epochs }, minimum));
  }
});

test("tampered contents, untrusted hosts and minimum revision still fail", () => {
  const keys = generateKeyPairSync("ed25519");
  const signed = sealDormantSourceExport(bundle(8), policy, keys.privateKey);
  const rotation = { epochs: [{ publicKey: keys.publicKey,
    fromSourceRevision: 1, fromHostApprovalRevision: 1 }] };
  assert.throws(() => verifyRotatingSourceExport(
    { ...signed, export: { ...signed.export, sourceRevision: 9 } },
    policy, rotation, minimum,
  ));
  assert.throws(() => verifyRotatingSourceExport(signed,
    { enabled: true, hosts: ["untrusted.example.org"] }, rotation, minimum,
  ));
  assert.throws(() => verifyRotatingSourceExport(signed, policy, rotation,
    { sourceRevision: 9, hostApprovalRevision: 9 },
  ));
});
