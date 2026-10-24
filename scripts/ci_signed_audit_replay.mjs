// P1-07: disposable GitHub Actions-only detached Ed25519 signature rehearsal.
// Trust the independently supplied public key, NEVER a key embedded in the bundle.
// This is not an operational signer, production archive or PostgreSQL restore.
import assert from "node:assert/strict";
import { sign, verify } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCiAuditBundle } from "./ci_audit_export.mjs";

const PREFIX = join(tmpdir(), "vns-p1-07-audit-ci-");
const DOMAIN = Buffer.from("VideoNewsStudio/P1-07/audit-manifest/ed25519/v1\0", "utf8");
const SIGNATURE_FILE = "manifest.sig";
const LEDGERS = [
  ["source_reviews", "source_reviews.ndjson"],
  ["editor_lifecycle", "editor_lifecycle.ndjson"],
  ["operator_governance", "operator_governance.ndjson"],
];

function requireCiDirectory(directory) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.CI !== "true" ||
    process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
    process.env.VNS_CI_AUDIT_EXPORT_PROBE !== "true" ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") ||
    typeof directory !== "string" ||
    !directory.startsWith(PREFIX) ||
    directory.slice(PREFIX.length).includes("/") ||
    directory.length === PREFIX.length
  ) {
    throw new Error("REFUSED: disposable GitHub Actions audit bundle only");
  }
}

function requireKey(key, type) {
  assert.ok(
    key?.type === type && key?.asymmetricKeyType === "ed25519",
    "A trusted Ed25519 key must be supplied independently",
  );
}

async function protectedFile(directory, filename, maximum) {
  const path = join(directory, filename);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Audit component is not a regular file");
  assert.equal(info.mode & 0o077, 0, "Audit component must be owner-only");
  assert.ok(info.size <= maximum, "Audit component exceeds the CI size bound");
  return readFile(path);
}

export async function signCiAuditManifest(directory, privateKey) {
  requireCiDirectory(directory);
  requireKey(privateKey, "private");
  // Validate content first. Do not sign a malformed or incomplete bundle.
  await verifyCiAuditBundle(directory);
  const manifest = await protectedFile(directory, "manifest.json", 64_000);
  const signature = sign(null, Buffer.concat([DOMAIN, manifest]), privateKey);
  assert.equal(signature.length, 64, "Unexpected Ed25519 signature length");
  await writeFile(join(directory, SIGNATURE_FILE), signature, { mode: 0o600, flag: "wx" });
}

export async function verifySignedCiAuditBundle(directory, trustedPublicKey) {
  requireCiDirectory(directory);
  requireKey(trustedPublicKey, "public");
  const manifest = await protectedFile(directory, "manifest.json", 64_000);
  const signature = await protectedFile(directory, SIGNATURE_FILE, 64);
  assert.equal(signature.length, 64, "Invalid Ed25519 signature length");
  assert.ok(
    verify(null, Buffer.concat([DOMAIN, manifest]), trustedPublicKey, signature),
    "Detached audit manifest signature verification failed",
  );
  // Never process/replay archive content until both trust and checksums pass.
  return verifyCiAuditBundle(directory);
}

// Restore *events* into a fresh, isolated in-memory representation only.
// This deliberately never attempts to reconstruct account state or PostgreSQL.
export async function replayVerifiedCiAuditEvents(directory, trustedPublicKey) {
  const verified = await verifySignedCiAuditBundle(directory, trustedPublicKey);
  const summary = [];
  for (let i = 0; i < LEDGERS.length; i += 1) {
    const [stream, filename] = LEDGERS[i];
    assert.equal(verified.streams[i].stream, stream);
    const contents = await protectedFile(directory, filename, 3_000_000);
    const ids = new Set();
    let previous = "";
    const rows = contents.length === 0 ? [] : contents.toString("utf8").trimEnd().split("\n");
    for (const line of rows) {
      const event = JSON.parse(line);
      assert.equal(event.stream, stream);
      assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i);
      assert.ok(!ids.has(event.id), "Duplicate audit event during offline replay");
      ids.add(event.id);
      const ordering = String(event.recorded_at) + "/" + event.id;
      assert.ok(previous === "" || previous <= ordering, "Audit event order is invalid");
      previous = ordering;
    }
    assert.equal(rows.length, verified.streams[i].rows, "Offline replay row mismatch");
    summary.push({ stream, rows: rows.length });
  }
  return summary;
}
