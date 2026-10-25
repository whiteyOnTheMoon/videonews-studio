import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, chmod, link, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sealProviderApiKey, unsealProviderApiKey } from "./provider-credential-crypto.js";
import { PROVIDER_MASTER_KEY_FILENAME, withProviderMasterKey } from "./provider-master-key-file.js";

const TEST_CREDENTIAL = "sk-ci-synthetic-not-an-actual-provider-key-01234";

async function privateFixture(
  run: (directory: string, secretPath: string, original: Buffer) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "vns-kek-ci-"));
  const secretPath = join(directory, PROVIDER_MASTER_KEY_FILENAME);
  const original = randomBytes(32);
  try {
    await chmod(directory, 0o700);
    await writeFile(secretPath, original, { mode: 0o600, flag: "wx" });
    await chmod(secretPath, 0o600);
    await run(directory, secretPath, original);
  } finally {
    original.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
}

test("isolated binary master key enables AES-GCM and is zeroized after use", async () => {
  await privateFixture(async (directory, secretPath, original) => {
    let callbackBuffer: Buffer | undefined;
    const result = await withProviderMasterKey(async (masterKey) => {
      callbackBuffer = masterKey;
      assert.equal(masterKey.length, 32);
      assert.notEqual(masterKey, original);
      assert.deepEqual(masterKey, original);
      const sealed = sealProviderApiKey("openai", TEST_CREDENTIAL, masterKey);
      assert.equal(unsealProviderApiKey("openai", sealed, masterKey), TEST_CREDENTIAL);
      return sealed;
    }, directory);
    assert.ok(callbackBuffer);
    assert.deepEqual(callbackBuffer, Buffer.alloc(32));
    assert.ok(!JSON.stringify(result).includes(TEST_CREDENTIAL));
    assert.deepEqual(await readFile(secretPath), original);
  });
});

test("secret buffer is cleared even if callback rejects, with sanitized error", async () => {
  await privateFixture(async (directory) => {
    let callbackBuffer: Buffer | undefined;
    await assert.rejects(
      withProviderMasterKey(async (masterKey) => {
        callbackBuffer = masterKey;
        throw new Error("synthetic-provider-secret-do-not-log");
      }, directory),
      (error: Error) => error.message === "Provider master key unavailable",
    );
    assert.ok(callbackBuffer);
    assert.deepEqual(callbackBuffer, Buffer.alloc(32));
  });
});

test("relative, missing, symbolic-link and insecure key directories fail closed", async () => {
  await privateFixture(async (directory, secretPath) => {
    const wrongPaths = ["relative/path", directory + "/../wrong", directory + "/"];
    for (const wrong of wrongPaths) {
      await assert.rejects(
        withProviderMasterKey(() => true, wrong),
        /Provider master key unavailable/,
      );
    }

    const linkDirectory = join(tmpdir(), "vns-kek-link-" + randomBytes(8).toString("hex"));
    try {
      await symlink(directory, linkDirectory);
      await assert.rejects(
        withProviderMasterKey(() => true, linkDirectory),
        /Provider master key unavailable/,
      );
    } finally {
      await rm(linkDirectory, { force: true });
    }

    await chmod(directory, 0o755);
    await assert.rejects(
      withProviderMasterKey(() => true, directory),
      /Provider master key unavailable/,
    );
    await chmod(directory, 0o700);
    assert.equal((await readFile(secretPath)).length, 32);
  });
});

test("master key must be a regular, singly linked 32-byte raw file with private mode", async () => {
  await privateFixture(async (directory, secretPath, original) => {
    for (const mode of [0o644, 0o660, 0o444, 0o700, 0o000]) {
      await chmod(secretPath, mode);
      await assert.rejects(
        withProviderMasterKey(() => true, directory),
        /Provider master key unavailable/,
      );
    }
    await chmod(secretPath, 0o400);
    assert.equal(await withProviderMasterKey(() => true, directory), true);

    const extraLink = join(directory, "extra-hardlink");
    await link(secretPath, extraLink);
    await assert.rejects(
      withProviderMasterKey(() => true, directory),
      /Provider master key unavailable/,
    );
    await rm(extraLink);

    await chmod(secretPath, 0o600);
    for (const size of [0, 16, 31, 33, 64]) {
      await writeFile(secretPath, randomBytes(size));
      await assert.rejects(
        withProviderMasterKey(() => true, directory),
        /Provider master key unavailable/,
      );
    }
    await writeFile(secretPath, original);
    assert.equal(await withProviderMasterKey(() => 42, directory), 42);
  });
});

test("symbolic-link key files are rejected; no key creation is performed", async () => {
  await privateFixture(async (directory, secretPath) => {
    const alternative = join(directory, "alternative");
    await writeFile(alternative, randomBytes(32), { mode: 0o600 });
    await rm(secretPath);
    await symlink(alternative, secretPath);
    await assert.rejects(
      withProviderMasterKey(() => true, directory),
      /Provider master key unavailable/,
    );
    assert.equal((await readFile(alternative)).length, 32);
  });
});
