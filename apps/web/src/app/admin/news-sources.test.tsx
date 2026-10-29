import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import NewsSources, { parseSourceViewSnapshot } from "./news-sources";

const source = {
  id: "ci_news",
  baseUrl: "https://example.org/news/",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "Synthetic fixture metadata only.",
  status: "pending",
  reviewedAt: "2026-10-26",
};
test("default-off Admin view has no source input, fetch or action controls", () => {
  const html = renderToStaticMarkup(<NewsSources enabled={false} />);
  assert.match(html, /Nachrichtenquellen/);
  assert.match(html, /nicht freigeschaltet/);
  assert.doesNotMatch(html, /<form|<input|<button|https:\/\/example\.org/);
});
test("even enabled, server rendering is read-only until personal-admin GET succeeds", () => {
  const html = renderToStaticMarkup(<NewsSources enabled />);
  assert.match(html, /Lade geschütztes Quellenregister/);
  assert.doesNotMatch(html, /<form|<button|ci_news/);
});
test("UI snapshot parser rejects extra sensitive fields, duplicates and forged approval shape", () => {
  assert.deepEqual(parseSourceViewSnapshot({ revision: 3, sources: [source] }), {
    revision: 3,
    sources: [source],
  });
  const examples = [
    { revision: 3, sources: [source], apiKey: "synthetic" },
    { revision: -1, sources: [] },
    { revision: 3, sources: [{ ...source, apiKey: "synthetic" }] },
    { revision: 3, sources: [source, source] },
    { revision: 3, sources: [{ ...source, intervalMinutes: 1 }] },
    { revision: 3, sources: [{ ...source, baseUrl: "http://127.0.0.1/" }] },
    { revision: 3, sources: [{ ...source, status: "enabled" }] },
    { revision: 3, sources: [{ ...source, reviewedAt: 0 }] },
    { revision: 3, sources: [{ ...source, licenseNotes: "" }] },
    { revision: 3, sources: null },
    null,
    [],
  ];
  for (const candidate of examples) assert.equal(parseSourceViewSnapshot(candidate), null);
});

test("source UI retains a separate reviewed feed URL but rejects cross-host or concealed endpoints", () => {
  const safe = { ...source, feedUrl: "https://example.org/rss.xml" };
  assert.deepEqual(parseSourceViewSnapshot({ revision: 1, sources: [safe] }), {
    revision: 1,
    sources: [safe],
  });
  for (const feedUrl of [
    "https://attacker.example/rss.xml",
    "https://example.org/rss.xml?token=private",
    "https://example.org/news/",
  ]) {
    assert.equal(
      parseSourceViewSnapshot({ revision: 1, sources: [{ ...safe, feedUrl }] }),
      null,
    );
  }
});
