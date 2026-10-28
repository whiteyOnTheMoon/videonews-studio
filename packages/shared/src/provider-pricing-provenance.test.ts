import assert from "node:assert/strict";
import test from "node:test";
import { officialPriceReviewSource } from "./provider-pricing-provenance.js";

test("official published vendor price references are accepted without retrieving prices", () => {
  for (const [provider, source] of [
    ["openai", "https://developers.openai.com/api/docs/pricing"],
    ["openai", "https://platform.openai.com/docs/pricing"],
    ["openai", "https://openai.com/api/"],
    ["google_gemini", "https://ai.google.dev/gemini-api/docs/pricing"],
    [
      "eur_usd",
      "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
    ],
    ["eur_usd", "https://data.ecb.europa.eu/methodology/exchange-rates"],
    [
      "eur_usd",
      "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=2",
    ],
  ] as const) {
    assert.equal(officialPriceReviewSource(provider, source), true, source);
  }
});

test("cross-provider pricing, social mirrors, sibling domains and spoofed hostnames are refused", () => {
  for (const [provider, source] of [
    ["openai", "https://ai.google.dev/gemini-api/docs/pricing"],
    ["google_gemini", "https://developers.openai.com/api/docs/pricing"],
    ["eur_usd", "https://ai.google.dev/gemini-api/docs/pricing"],
    ["openai", "https://developers.openai.com.evil.invalid/api/docs/pricing"],
    ["google_gemini", "https://ai.google.dev.evil.invalid/gemini-api/docs/pricing"],
    ["openai", "https://developers.openai.com@evil.invalid/api/docs/pricing"],
    ["openai", "https://developers.openai.com/api/docs/pricing#altered"],
    ["openai", "https://developers.openai.com:8443/api/docs/pricing"],
    ["openai", "https://developers.openai.com./api/docs/pricing"],
    ["openai", "https://developers.openai.com/api/docs/%70ricing"],
    ["google_gemini", "https://ai.google.dev/gemini-api/docs/pricing%2f.."],
    ["eur_usd", "https://www.ecb.europa.eu/other"],
    ["eur_usd", "https://data.ecb.europa.eu/key-figures/other"],
    ["eur_usd", "https://data-api.ecb.europa.eu/service/data/EXR/D.GBP.EUR.SP00.A"],
    ["openai", "https://openai.com/login"],
    ["openai", "https://example.org/prices"],
    ["openai", "https://openai.com.evil.invalid/api"],
    ["openai", "http://openai.com/api"],
    ["openai", "https://openai.com/api/ "],
    ["openai", "https://openai.com/api\\redirect"],
  ] as const) {
    assert.equal(officialPriceReviewSource(provider, source), false, source);
  }
  assert.equal(officialPriceReviewSource("openai", null), false);
  assert.equal(officialPriceReviewSource("openai", "https://openai.com/api".repeat(60)), false);
  assert.equal(officialPriceReviewSource("unauthorized" as never, "https://openai.com/api"), false);
});

test("source references are provenance only, not a live-price or FX determination", () => {
  const sources: unknown[] = [
    "https://openai.com/api",
    "https://ai.google.dev/gemini-api/docs/pricing",
    "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
  ];
  assert.equal(sources.length, 3);
  assert.equal(officialPriceReviewSource("openai", sources[0]), true);
  // This module does not perform network calls, set budget flags,
  // interpret provider pricing modes or determine exchange-rate buffers.
});
