// P1-07 CI-only encryption and independent trust-anchor rehearsal.
// Not connected to PostgreSQL, Redis, VPS, cloud storage or real backup files.
import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  sign,
  verify,
  randomBytes,
} from "node:crypto";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const PREFIX = join(tmpdir(), "vns-ci-sealed-backup-");
const DOMAIN = Buffer.from("VideoNewsStudio/P1-07/backup-envelope/ed25519/v1\0", "utf8");
const AAD = Buffer.from("VideoNewsStudio/P1-07/backup-envelope/aes256gcm/v1\0", "utf8");
const ENVELOPE_FILE = "sealed.json";
const SIGNATURE_FILE = "sealed.sig";
const MAX_PLAINTEXT = 48_000;
const MAX_ENVELOPE = 128_000;
const ID_PATTERN = /^[a-z][a-z0-9_-]{5,39}$/;
const HEX = /^[a-f0-9]{64}$/;

function requireCi() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.CI !== "true" ||
    process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
    process.env.VNS_CI_BACKUP_CRYPTO !== "true" ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
  ) {
    throw new Error("REFUSED: disposable GitHub Actions backup crypto only");
  }
}

function requireDirectory(directory) {
  assert.equal(typeof directory, "string");
  const canonical = resolve(directory);
  assert.ok(
    canonical.startsWith(PREFIX) &&
      canonical.length > PREFIX.length &&
      !canonical.slice(PREFIX.length).includes(sep),
    "REFUSED: non-CI sealed backup directory",
  );
  return canonical;
}

async function regularFile(path, maxBytes) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Non-regular backup component");
  assert.equal(info.nlink, 1, "Hard-linked backup component forbidden");
  assert.equal(info.mode & 0o077, 0, "Backup component must be owner-only");
  assert.ok(info.size > 0 && info.size <= maxBytes, "Backup component exceeds bound");
  return readFile(path);
}

function requireKey(key, type) {
  assert.ok(
    key?.type === type && key?.asymmetricKeyType === "ed25519",
    "Independent Ed25519 key required",
  );
}

export function signingKeyId(publicKey) {
  requireKey(publicKey, "public");
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function requireBackupId(id) {
  assert.match(id, ID_PATTERN, "Invalid synthetic backup ID");
}

function requireEncryptionKey(key) {
  assert.ok(Buffer.isBuffer(key) && key.length === 32, "Independent 256-bit key required");
}

export async function sealCiBackup(directory, plaintext, options) {
  requireCi();
  const target = requireDirectory(directory);
  assert.ok((await lstat(target)).isDirectory(), "Invalid CI backup target");
  assert.deepEqual(await readdir(target), [], "Refusing to overwrite an existing backup");
  const { backupId, generation, encryptionKey, signingPrivateKey, signingPublicKey } = options;
  requireBackupId(backupId);
  assert.ok(Number.isSafeInteger(generation) && generation >= 1);
  requireEncryptionKey(encryptionKey);
  requireKey(signingPrivateKey, "private");
  requireKey(signingPublicKey, "public");
  assert.ok(Buffer.isBuffer(plaintext) && plaintext.length > 0);
  assert.ok(plaintext.length <= MAX_PLAINTEXT, "Synthetic plaintext exceeds limit");
  const signatureProbe = sign(null, DOMAIN, signingPrivateKey);
  assert.ok(verify(null, DOMAIN, signingPublicKey, signatureProbe), "Keypair mismatch");

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    format: "vns-ci-sealed-backup-v1",
    backupId,
    generation,
    signingKeyId: signingKeyId(signingPublicKey),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  const bytes = Buffer.from(JSON.stringify(envelope) + "\n", "utf8");
  assert.ok(bytes.length <= MAX_ENVELOPE);
  const signature = sign(null, Buffer.concat([DOMAIN, bytes]), signingPrivateKey);
  let wroteEnvelope = false;
  let wroteSignature = false;
  try {
    await writeFile(join(target, ENVELOPE_FILE), bytes, { mode: 0o600, flag: "wx" });
    wroteEnvelope = true;
    await writeFile(join(target, SIGNATURE_FILE), signature, { mode: 0o600, flag: "wx" });
    wroteSignature = true;
  } catch (error) {
    if (wroteEnvelope) await rm(join(target, ENVELOPE_FILE), { force: true });
    if (wroteSignature) await rm(join(target, SIGNATURE_FILE), { force: true });
    throw error;
  }
  return { backupId, generation, signingKeyId: envelope.signingKeyId };
}

export async function recoverCiBackup(directory, independentPolicy, encryptionKey) {
  requireCi();
  const target = requireDirectory(directory);
  requireEncryptionKey(encryptionKey);
  assert.ok(independentPolicy && independentPolicy.keys instanceof Map);
  requireBackupId(independentPolicy.backupId);
  assert.ok(Number.isSafeInteger(independentPolicy.expectedGeneration));
  assert.ok(independentPolicy.expectedGeneration >= 1);
  assert.deepEqual(
    (await readdir(target)).sort(),
    [ENVELOPE_FILE, SIGNATURE_FILE].sort(),
    "Unexpected sealed backup directory contents",
  );

  const bytes = await regularFile(join(target, ENVELOPE_FILE), MAX_ENVELOPE);
  const signature = await regularFile(join(target, SIGNATURE_FILE), 64);
  assert.equal(signature.length, 64, "Invalid detached signature size");
  const data = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(data), [
    "format",
    "backupId",
    "generation",
    "signingKeyId",
    "nonce",
    "tag",
    "ciphertext",
  ]);
  assert.equal(data.format, "vns-ci-sealed-backup-v1");
  requireBackupId(data.backupId);
  assert.equal(data.backupId, independentPolicy.backupId, "Unexpected backup identity");
  assert.equal(
    data.generation,
    independentPolicy.expectedGeneration,
    "Stale or unknown generation",
  );
  assert.match(data.signingKeyId, HEX);
  const trusted = independentPolicy.keys.get(data.signingKeyId);
  assert.ok(trusted?.active === true, "Signing key missing or revoked by independent policy");
  requireKey(trusted.publicKey, "public");
  assert.equal(signingKeyId(trusted.publicKey), data.signingKeyId, "Signer fingerprint mismatch");
  assert.ok(
    verify(null, Buffer.concat([DOMAIN, bytes]), trusted.publicKey, signature),
    "Untrusted or altered backup envelope signature",
  );

  for (const value of [data.nonce, data.tag, data.ciphertext]) {
    assert.ok(typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value));
  }
  const nonce = Buffer.from(data.nonce, "base64");
  const tag = Buffer.from(data.tag, "base64");
  const encrypted = Buffer.from(data.ciphertext, "base64");
  assert.equal(nonce.length, 12);
  assert.equal(tag.length, 16);
  assert.ok(encrypted.length > 0 && encrypted.length <= MAX_PLAINTEXT);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
