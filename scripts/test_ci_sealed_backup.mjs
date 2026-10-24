// P1-07 synthetic cryptographic recovery tests, never real data or secrets.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverCiBackup, sealCiBackup, signingKeyId } from "./ci_sealed_backup.mjs";

const CONTEXT = Buffer.from("VideoNewsStudio/P1-07/backup-envelope/ed25519/v1\0", "utf8");
const BACKUP_ID = "synthetic-backup-001";
const PAYLOAD = Buffer.from(
  "synthetic CI-only PostgreSQL/Redis backup fixture: no operational credentials",
);

async function fixture(generation = 7) {
  const source = await mkdtemp(join(tmpdir(), "vns-ci-sealed-backup-"));
  const restored = await mkdtemp(join(tmpdir(), "vns-ci-sealed-backup-"));
  const signer = generateKeyPairSync("ed25519");
  const keyId = signingKeyId(signer.publicKey);
  const encryptionKey = randomBytes(32);
  const policy = {
    backupId: BACKUP_ID,
    expectedGeneration: generation,
    keys: new Map([[keyId, { active: true, publicKey: signer.publicKey }]]),
  };
  async function copy() {
    await copyFile(join(source, "sealed.json"), join(restored, "sealed.json"));
    await copyFile(join(source, "sealed.sig"), join(restored, "sealed.sig"));
  }
  async function seal() {
    await sealCiBackup(source, PAYLOAD, {
      backupId: BACKUP_ID,
      generation,
      encryptionKey,
      signingPrivateKey: signer.privateKey,
      signingPublicKey: signer.publicKey,
    });
  }
  async function dispose() {
    await Promise.all([
      rm(source, { recursive: true, force: true }),
      rm(restored, { recursive: true, force: true }),
    ]);
  }
  return { source, restored, signer, keyId, encryptionKey, policy, copy, seal, dispose };
}

test("independent restore directory decrypts only with out-of-band trusted keys", async () => {
  const f = await fixture();
  try {
    await f.seal();
    await f.copy();
    const raw = await readFile(join(f.restored, "sealed.json"), "utf8");
    assert.ok(!raw.includes(PAYLOAD.toString("utf8")), "Plaintext leaked in sealed storage");
    assert.deepEqual(await recoverCiBackup(f.restored, f.policy, f.encryptionKey), PAYLOAD);
    await assert.rejects(f.seal(), /Refusing to overwrite/);
  } finally {
    await f.dispose();
  }
});

const attacks = [
  [
    "wrong independent encryption key",
    async (f) => recoverCiBackup(f.restored, f.policy, randomBytes(32)),
  ],
  [
    "stale signed generation",
    async (f) =>
      recoverCiBackup(f.restored, { ...f.policy, expectedGeneration: 8 }, f.encryptionKey),
  ],
  [
    "unexpected backup identity",
    async (f) =>
      recoverCiBackup(f.restored, { ...f.policy, backupId: "synthetic-other-id" }, f.encryptionKey),
  ],
  [
    "revoked signing key",
    async (f) =>
      recoverCiBackup(
        f.restored,
        {
          ...f.policy,
          keys: new Map([[f.keyId, { active: false, publicKey: f.signer.publicKey }]]),
        },
        f.encryptionKey,
      ),
  ],
  [
    "no externally pinned signing key",
    async (f) => recoverCiBackup(f.restored, { ...f.policy, keys: new Map() }, f.encryptionKey),
  ],
  [
    "substituted signer in trusted-key map",
    async (f) => {
      const attacker = generateKeyPairSync("ed25519");
      return recoverCiBackup(
        f.restored,
        {
          ...f.policy,
          keys: new Map([[f.keyId, { active: true, publicKey: attacker.publicKey }]]),
        },
        f.encryptionKey,
      );
    },
  ],
  [
    "altered authenticated ciphertext",
    async (f) => {
      const path = join(f.restored, "sealed.json");
      const envelope = JSON.parse(await readFile(path, "utf8"));
      envelope.ciphertext = Buffer.from("fake-tampered-data").toString("base64");
      await writeFile(path, JSON.stringify(envelope) + "\n");
      return recoverCiBackup(f.restored, f.policy, f.encryptionKey);
    },
  ],
  [
    "malformed detached signature",
    async (f) => {
      await writeFile(join(f.restored, "sealed.sig"), Buffer.alloc(64, 5));
      return recoverCiBackup(f.restored, f.policy, f.encryptionKey);
    },
  ],
  [
    "unexpected archive file",
    async (f) => {
      await writeFile(join(f.restored, "credentials.txt"), "unrecognized");
      return recoverCiBackup(f.restored, f.policy, f.encryptionKey);
    },
  ],
  [
    "symbolic link instead of ciphertext",
    async (f) => {
      await rm(join(f.restored, "sealed.json"));
      await symlink(join(f.source, "sealed.json"), join(f.restored, "sealed.json"));
      return recoverCiBackup(f.restored, f.policy, f.encryptionKey);
    },
  ],
  [
    "tampered GCM tag signed with a trusted synthetic key",
    async (f) => {
      const path = join(f.restored, "sealed.json");
      const envelope = JSON.parse(await readFile(path, "utf8"));
      envelope.tag = Buffer.alloc(16, 1).toString("base64");
      const envelopeBytes = Buffer.from(JSON.stringify(envelope) + "\n");
      await writeFile(path, envelopeBytes);
      const newSignature = sign(null, Buffer.concat([CONTEXT, envelopeBytes]), f.signer.privateKey);
      await writeFile(join(f.restored, "sealed.sig"), newSignature);
      return recoverCiBackup(f.restored, f.policy, f.encryptionKey);
    },
  ],
];

for (const [name, attack] of attacks) {
  test("rejects " + name, async () => {
    const f = await fixture();
    try {
      await f.seal();
      await f.copy();
      await assert.rejects(attack(f));
    } finally {
      await f.dispose();
    }
  });
}

test("signing-key rotation denies old keys and permits separately pinned new generation", async () => {
  const old = await fixture(7);
  const next = await fixture(8);
  try {
    await old.seal();
    await old.copy();
    await next.seal();
    await next.copy();
    const rotatedPolicy = {
      backupId: BACKUP_ID,
      expectedGeneration: 8,
      keys: new Map([
        [old.keyId, { active: false, publicKey: old.signer.publicKey }],
        [next.keyId, { active: true, publicKey: next.signer.publicKey }],
      ]),
    };
    assert.deepEqual(
      await recoverCiBackup(next.restored, rotatedPolicy, next.encryptionKey),
      PAYLOAD,
    );
    await assert.rejects(
      recoverCiBackup(old.restored, { ...rotatedPolicy, expectedGeneration: 7 }, old.encryptionKey),
      /revoked/,
    );
    await assert.rejects(
      recoverCiBackup(old.restored, rotatedPolicy, old.encryptionKey),
      /generation/,
    );
  } finally {
    await old.dispose();
    await next.dispose();
  }
});

test("blocks use when CI-only gate is missing", async () => {
  const f = await fixture();
  const previous = process.env.VNS_CI_BACKUP_CRYPTO;
  process.env.VNS_CI_BACKUP_CRYPTO = "false";
  try {
    await assert.rejects(f.seal(), /REFUSED/);
  } finally {
    process.env.VNS_CI_BACKUP_CRYPTO = previous;
    await f.dispose();
  }
});
