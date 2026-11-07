import assert from "node:assert/strict";
import test from "node:test";
import { previewReviewedArticleQueryIdentity } from "./feed-article-query-identity-preview.js";
import { parseReviewedSourceRegistry } from "./source-registry.js";

const root = "https://www.example.org/";
const source = (id: string, baseUrl: string, status: "approved" | "blocked" = "approved") => ({
  id,
  baseUrl,
  access: "rss",
  status,
  intervalMinutes: 60,
  termsUrl: root + "terms/",
  usage: "metadata_only",
  licenseNotes: "Synthetic test-only source and metadata approval.",
  reviewedAt: "2026-11-07",
});
const registry = parseReviewedSourceRegistry(
  JSON.stringify({
    version: 1,
    sources: [
      source("test_news", root + "news/"),
      source("test_private", root + "news/private/", "blocked"),
      source("test_weather", root + "weather/"),
    ],
  }),
  { enabled: true, hosts: ["www.example.org"] },
);
const approved = registry[0]!;
const policy = {
  sourceId: "test_news",
  baseUrl: root + "news/",
  functionalKeys: ["article_id", "revision"],
  trackingKeys: ["utm_source", "utm_campaign"],
};

test("offline identity preview preserves navigation and distinct functional article IDs", () => {
  const a = root + "news/item?article_id=101&utm_source=rss";
  const b = root + "news/item?article_id=102&utm_source=rss";
  const first = previewReviewedArticleQueryIdentity(a, approved, registry, policy);
  const second = previewReviewedArticleQueryIdentity(b, approved, registry, policy);
  assert.deepEqual(first, {
    navigationUrl: a,
    identityUrl: root + "news/item?article_id=101",
  });
  assert.deepEqual(second, {
    navigationUrl: b,
    identityUrl: root + "news/item?article_id=102",
  });
  assert.notEqual(first?.identityUrl, second?.identityUrl);
});

test("identity key is stable under order changes, tracking differences cannot change it", () => {
  const a = root + "news/item?revision=2&article_id=101&utm_source=rss";
  const b = root + "news/item?utm_campaign=press&article_id=101&revision=2";
  const first = previewReviewedArticleQueryIdentity(a, approved, registry, policy);
  const second = previewReviewedArticleQueryIdentity(b, approved, registry, policy);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.navigationUrl, a);
  assert.equal(second.navigationUrl, b);
  assert.equal(first.identityUrl, root + "news/item?article_id=101&revision=2");
  assert.equal(first.identityUrl, second.identityUrl);
});

test("unreviewed keys, duplicates, encodings, hostile values, and fragments fail closed", () => {
  const rejected = [
    root + "news/item?article_id=1&article_id=2",
    root + "news/item?article_id=",
    root + "news/item?article_id=1&unreviewed=2",
    root + "news/item?article_id=1%262",
    root + "news/item?article_id=1#fragment",
    root + "news/item?article_id=1+2",
    root + "news/item?article_id=https://example.org/",
    root + "news/item?article_id=1&",
    root + "news/item?article_id=1=2",
    root + "news/item?article_id=1&&revision=2",
    root + "news/item?article_id=1?revision=2",
    root + "news/item?Article_id=1",
    root + "news/item?article_id=12345678901234567890123456789012345678901234567890123456789012345",
    root + "news/../private/item?article_id=1",
    root + "news/private/item?article_id=1",
    root + "weather/item?article_id=1",
    "http://www.example.org/news/item?article_id=1",
    "https://not-example.org/news/item?article_id=1",
    root + "news/item",
  ];
  for (const input of rejected) {
    assert.equal(
      previewReviewedArticleQueryIdentity(input, approved, registry, policy),
      null,
      input,
    );
  }
});

test("invalid policies are denied; tracking removal requires source-specific explicit review", () => {
  const article = root + "news/item?article_id=1&utm_source=rss";
  const invalid = [
    { ...policy, sourceId: "test_weather" },
    { ...policy, baseUrl: root + "weather/" },
    { ...policy, functionalKeys: [] },
    { ...policy, functionalKeys: ["article_id", "article_id"] },
    { ...policy, trackingKeys: ["utm_source", "article_id"] },
    { ...policy, trackingKeys: ["unknown_key"] },
    { ...policy, functionalKeys: ["article_id", "utm_source"] },
    { ...policy, functionalKeys: ["Article_id"] },
    { ...policy, functionalKeys: ["article_id", "revision", "a", "b", "c", "d", "e"] },
  ];
  // An empty functional policy is not by itself unsafe: its unapproved
  // article_id remains unknown, so this exact input must still be refused.
  for (const p of invalid) {
    assert.equal(previewReviewedArticleQueryIdentity(article, approved, registry, p), null);
  }
  assert.equal(
    previewReviewedArticleQueryIdentity(article, approved, registry, {
      ...policy,
      trackingKeys: [],
    }),
    null,
  );
  assert.equal(previewReviewedArticleQueryIdentity(article, registry[1]!, registry, policy), null);
});

test("tracking-only example is a review preview and never a persistence authorization", () => {
  const url = root + "news/item?utm_source=rss";
  const preview = previewReviewedArticleQueryIdentity(url, approved, registry, {
    sourceId: approved.id,
    baseUrl: approved.baseUrl,
    functionalKeys: [],
    trackingKeys: ["utm_source"],
  });
  assert.deepEqual(preview, { navigationUrl: url, identityUrl: root + "news/item" });
});
