import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  dormantPostClaimCredentialScope,
  unsealWorkerCredential,
  withWorkerMasterKey,
  type SealedWorkerCredential,
} from "./provider-claimed-credential-scope.js";

const ID = "a4300007-0000-4000-8000-000000000007";
const KEY = Buffer.alloc(32, 103);
const SECRET = "synthetic_test_key_012345678901234567890123";
const FAIL = "Provider credential unavailable";

function encrypted(provider: string = "openai", key: Buffer = KEY): SealedWorkerCredential {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from("vns:ai-provider:v1:" + provider));
  const ciphertext = Buffer.concat([cipher.update(SECRET, "utf8"), cipher.final()]);
  return {
    format_version: 1,
    nonce,
    ciphertext,
    auth_tag: cipher.getAuthTag(),
  };
}

function fixtureDb(producer: () => SealedWorkerCredential = () => encrypted(), onSql?: () => void) {
  const statements: Array<{ text: string; args: unknown[] }> = [];
  const pool = {
    async query(text: string, args: unknown[]) {
      statements.push({ text, args });
      onSql?.();
      return { rows: [producer()] };
    },
  } as unknown as Pick<Pool, "query">;
  return { pool, statements };
}

test("worker secret scope is dormant unless explicitly constructed", () => {
  const { pool, statements } = fixtureDb();
  assert.throws(() => dormantPostClaimCredentialScope(pool), /disabled/);
  assert.deepEqual(statements, []);
});

test("PostgreSQL claim-bound envelope is read exactly once before master key", async () => {
  const events: string[] = [];
  const sealed = encrypted();
  const { pool, statements } = fixtureDb(
    () => sealed,
    () => events.push("sql"),
  );
  const scope = dormantPostClaimCredentialScope(pool, true, async (callback) => {
    events.push("master-key");
    return callback(Buffer.from(KEY));
  });
  const result = await scope.withCredential(ID, "openai", async (secret) => {
    events.push("operation");
    assert.equal(secret, SECRET);
    return { ok: true as const };
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, ["sql", "master-key", "operation"]);
  assert.equal(statements.length, 1);
  assert.match(
    statements[0]!.text,
    /^SELECT format_version,nonce,ciphertext,auth_tag FROM vns\.claimed_provider_sealed_key/,
  );
  assert.deepEqual(statements[0]!.args, [ID, "openai"]);
  assert.ok(sealed.nonce.every((x) => x === 0));
  assert.ok(sealed.ciphertext.every((x) => x === 0));
  assert.ok(sealed.auth_tag.every((x) => x === 0));
});

test("invalid identifiers, providers and missing SQL evidence never load the KEK", async () => {
  let reads = 0;
  const { pool, statements } = fixtureDb(
    () => encrypted(),
    () => reads++,
  );
  const scope = dormantPostClaimCredentialScope(pool, true, async () => {
    throw Error("unexpected master-key access");
  });
  for (const [id, provider] of [
    ["not-uuid", "openai"],
    [ID, "not-a-vendor"],
    [ID, "openai/../"],
    ["", "google_gemini"],
  ]) {
    await assert.rejects(
      scope.withCredential(id!, provider as never, async () => SECRET),
      /unavailable/,
    );
  }
  assert.equal(reads, 0);
  assert.equal(statements.length, 0);
});

test("SQL denied, absent, duplicate, or malformed envelopes cannot reveal a key", async () => {
  let read = 0;
  for (const mode of ["denied", "none", "many", "bad"] as const) {
    const { pool } = fixtureDb(() => encrypted());
    const custom = {
      async query() {
        read++;
        if (mode === "denied") throw Error("db-private-password");
        if (mode === "none") return { rows: [] };
        if (mode === "many") return { rows: [encrypted(), encrypted()] };
        return { rows: [{ ...encrypted(), nonce: Buffer.alloc(3) }] };
      },
    } as unknown as Pick<Pool, "query">;
    void pool;
    let keyRead = false;
    const scope = dormantPostClaimCredentialScope(custom, true, async (callback) => {
      keyRead = true;
      return callback(Buffer.from(KEY));
    });
    await assert.rejects(
      scope.withCredential(ID, "openai", async () => SECRET),
      (e: Error) => e.message === FAIL && !e.message.includes("password"),
    );
    assert.equal(keyRead, mode === "bad");
  }
  assert.equal(read, 4);
});

test("wrong provider key, wrong KEK and tampered ciphertext fail authentication", () => {
  for (const [provider, sealed, key] of [
    ["google_gemini", encrypted(), KEY],
    ["openai", encrypted(), Buffer.alloc(32, 4)],
    ["openai", { ...encrypted(), auth_tag: Buffer.alloc(16, 0) }, KEY],
    ["openai", { ...encrypted(), format_version: 2 }, KEY],
  ] as const) {
    assert.throws(
      () => unsealWorkerCredential(provider as never, sealed, key),
      (e: Error) => e.message === FAIL,
    );
  }
});

test("operation failure is generic and does not leave reusable sealed bytes", async () => {
  const sealed = encrypted();
  const { pool } = fixtureDb(() => sealed);
  const scope = dormantPostClaimCredentialScope(pool, true, async (cb) => cb(Buffer.from(KEY)));
  await assert.rejects(
    scope.withCredential(ID, "openai", async () => {
      throw Error("sensitive-provider-payload");
    }),
    (e: Error) => e.message === FAIL,
  );
  assert.ok(sealed.ciphertext.every((x) => x === 0));
});

test("worker key file rejects symlinks, loose modes and wrong lengths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vns-ci-secret-"));
  const file = join(directory, "provider-master-key");
  try {
    await chmod(directory, 0o700);
    await writeFile(file, KEY, { mode: 0o600, flag: "wx" });
    let observed: Buffer | undefined;
    const success = await withWorkerMasterKey(async (key) => {
      observed = key;
      assert.deepEqual(key, KEY);
      return 42;
    }, directory);
    assert.equal(success, 42);
    assert.ok(observed?.every((x) => x === 0));
    await chmod(file, 0o644);
    await assert.rejects(
      withWorkerMasterKey(async () => 1, directory),
      /unavailable/,
    );
    await chmod(file, 0o600);
    await unlink(file);
    await writeFile(file, Buffer.alloc(31), { mode: 0o600, flag: "wx" });
    await assert.rejects(
      withWorkerMasterKey(async () => 1, directory),
      /unavailable/,
    );
    await unlink(file);
    await symlink(join(directory, "missing"), file);
    await assert.rejects(
      withWorkerMasterKey(async () => 1, directory),
      /unavailable/,
    );
    await chmod(directory, 0o755);
    await assert.rejects(
      withWorkerMasterKey(async () => 1, directory),
      /unavailable/,
    );
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
