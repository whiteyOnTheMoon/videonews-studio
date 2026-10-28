import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { openProviderPrompt, sealProviderPrompt } from "./provider-encrypted-prompt.js";

test("round-trip binds encrypted prompt to its actual SHA-256", () => {
  const key = randomBytes(32);
  const prompt = "Verified article source: Bonn — ü.";
  const envelope = sealProviderPrompt(prompt, key);
  assert.equal(openProviderPrompt(envelope, key), prompt);
  assert.equal(envelope.version, 1);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(JSON.stringify(envelope).includes(prompt), false);
  const again = sealProviderPrompt(prompt, key);
  assert.notEqual(envelope.iv, again.iv);
  assert.notEqual(envelope.ciphertext, again.ciphertext);
});

test("tampering, wrong key and digest substitution all fail closed", () => {
  const key = randomBytes(32);
  const payload = sealProviderPrompt("An approved prompt", key);
  for (const changed of [
    { ...payload, sha256: "0".repeat(64) },
    { ...payload, ciphertext: "AAAA" },
    { ...payload, iv: "AAAA" },
    { ...payload, tag: "AAAA" },
    { ...payload, version: 2 },
    { ...payload, unexpected: "extra" },
  ]) assert.throws(() => openProviderPrompt(changed as never, key), /unavailable/);
  assert.throws(() => openProviderPrompt(payload, randomBytes(32)), /unavailable/);
});

test("weak keys and unbounded prompts are rejected before encryption", () => {
  const key = randomBytes(32);
  for (const prompt of ["", " ", "X".repeat(32769)]) {
    assert.throws(() => sealProviderPrompt(prompt, key), /unavailable/);
  }
  assert.throws(() => sealProviderPrompt("Valid", randomBytes(16)), /unavailable/);
});
