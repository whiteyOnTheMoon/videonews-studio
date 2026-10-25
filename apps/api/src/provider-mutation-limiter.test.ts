import assert from "node:assert/strict";
import test from "node:test";
import { ProviderMutationLimiter } from "./provider-mutation-limiter.js";

test("shared limiter permits five attempts, then rejects until window reset", () => {
  let time = 10_000;
  const limiter = new ProviderMutationLimiter(() => time);
  for (let i = 0; i < 5; i++) assert.equal(limiter.allow(), true);
  assert.equal(limiter.allow(), false);
  time += 59_999;
  assert.equal(limiter.allow(), false);
  time++;
  assert.equal(limiter.allow(), true);
});

test("limiter fails closed for non-monotonic or invalid clock readings", () => {
  let time = 5_000;
  const limiter = new ProviderMutationLimiter(() => time, 1);
  assert.equal(limiter.allow(), true);
  time = 4_999;
  assert.equal(limiter.allow(), false);
  time = Number.NaN;
  assert.equal(limiter.allow(), false);
  time = 65_000;
  assert.equal(limiter.allow(), true);
});

test("limiter disallows invalid configuration", () => {
  for (const limit of [0, -1, 101, Number.NaN]) {
    assert.throws(() => new ProviderMutationLimiter(Date.now, limit));
  }
  assert.throws(() => new ProviderMutationLimiter(Date.now, 5, 0));
  assert.throws(() => new ProviderMutationLimiter(Date.now, 5, 999));
});
