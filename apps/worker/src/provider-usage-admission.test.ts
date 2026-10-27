import assert from "node:assert/strict";
import test from "node:test";
import { admitReportedUsage, reconcileReportedUsage } from "./provider-usage-admission.js";

const base = Object.freeze({
  jobId: "b274db39-cfd5-46bf-8438-27557b89201a",
  requestId: "provider_req_0001",
  responseId: "provider_resp_0001",
  provider: "openai",
  model: "test-model",
  priceVersion: "price_version_1",
  currency: "USD",
  inputTokens: 100,
  outputTokens: 40,
  cachedInputTokens: 25,
  costMicroUsd: "250",
});

test("provider-reported usage remains disabled, unpersisted and auditable", () => {
  const value = admitReportedUsage(base);
  assert.equal(value.source, "provider_response");
  assert.equal(value.persistent, false);
  assert.equal(value.approvedForPayment, false);
  assert.ok(Object.isFrozen(value));
  assert.deepEqual(reconcileReportedUsage("500", value), {
    state: "within_reservation",
    deltaMicroUsd: "250",
  });
  assert.deepEqual(reconcileReportedUsage("100", value), {
    state: "over_reservation",
    deltaMicroUsd: "-150",
  });
});

test("missing, contradictory, unknown or unpriced provider usage is denied", () => {
  const invalid: unknown[] = [
    null,
    {},
    { ...base, costMicroUsd: undefined },
    { ...base, costMicroUsd: "-1" },
    { ...base, currency: "EUR" },
    { ...base, inputTokens: 2.5 },
    { ...base, cachedInputTokens: 101 },
    { ...base, provider: "untrusted" },
    { ...base, priceVersion: "" },
    { ...base, apiKey: "never accept secrets" },
    { ...base, responseId: "" },
    { ...base, outputTokens: -1 },
    { ...base, costMicroUsd: "NaN" },
    { ...base, costMicroUsd: "1.1" },
  ];
  for (const value of invalid) {
    assert.throws(() => admitReportedUsage(value), /Invalid provider usage/);
  }
  assert.throws(() => reconcileReportedUsage("-1", admitReportedUsage(base)));
});
