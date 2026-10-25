import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  publicProviderKeyStatus,
  sealProviderApiKey,
  unsealProviderApiKey,
} from "./provider-credential-crypto.js";

const TEST_KEY = "sk-offline-fixture-do-not-use-123456789";

test("AES-256-GCM seals provider secrets, rotates nonce and authenticates provider identity", () => {
  const master = randomBytes(32);
  const first = sealProviderApiKey("openai", TEST_KEY, master);
  const second = sealProviderApiKey("openai", TEST_KEY, master);
  assert.notDeepEqual(first, second);
  assert.equal(first.version, 1);
  assert.equal(unsealProviderApiKey("openai", first, master), TEST_KEY);
  assert.equal(unsealProviderApiKey("openai", second, master), TEST_KEY);
  assert.ok(!JSON.stringify(first).includes(TEST_KEY));
  assert.equal(first.nonce.length, 16);
  assert.ok(Object.isFrozen(first));
  assert.throws(
    () => unsealProviderApiKey("google_gemini", first, master),
    /Encrypted provider credential unavailable/,
  );
  assert.throws(
    () => unsealProviderApiKey("openai", first, randomBytes(32)),
    /Encrypted provider credential unavailable/,
  );
});

test("tampering with any authenticated part is rejected without plaintext", () => {
  const master = randomBytes(32);
  const sealed = sealProviderApiKey("google_gemini", "AIzaSyntheticNotRealTestKey12345", master);
  for (const modified of [
    { ...sealed, nonce: "A".repeat(16) },
    { ...sealed, tag: "A".repeat(22) },
    { ...sealed, ciphertext: "A".repeat(sealed.ciphertext.length) },
    { ...sealed, version: 2 },
    { ...sealed, extra: "do-not-accept" },
    { ...sealed, nonce: "base64%" },
    { ...sealed, ciphertext: "" },
    { ...sealed, tag: "" },
    { ...sealed, tag: "a" },
    { ...sealed, ciphertext: "Z" },
    null,
    [],
  ]) {
    assert.throws(() => unsealProviderApiKey("google_gemini", modified, master), /credential/i);
  }
});

test("secret material is validated but never put into a public status", () => {
  const master = randomBytes(32);
  for (const input of [
    "",
    "short",
    " has-leading-space12345",
    "contains spaces abcdefghij",
    "contains\nnewline-000000",
    "a".repeat(513),
    "test\u0000forbidden",
  ]) {
    assert.throws(() => sealProviderApiKey("openai", input, master), /Invalid provider/);
  }
  assert.throws(
    () => sealProviderApiKey("openai", TEST_KEY, randomBytes(16)),
    /Invalid provider/,
  );
  assert.throws(
    () => sealProviderApiKey("other" as never, TEST_KEY, master),
    /Invalid provider/,
  );
  assert.deepEqual(publicProviderKeyStatus({ provider: "openai", configured: true }), {
    provider: "openai",
    configured: true,
    active: false,
  });
  for (const data of [
    { provider: "other", configured: true },
    { provider: "openai", configured: true, key: "leaked" },
    { provider: "openai", configured: "yes" },
  ]) {
    assert.throws(() => publicProviderKeyStatus(data), /Invalid provider/);
  }
});
