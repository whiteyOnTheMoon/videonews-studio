import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import EditorialProfiles, { parseEditorialProfileSnapshot } from "./editorial-profiles";
import EditorialAuditExport, { validEditorialExportBatch } from "./editorial-audit-export";

const profile = {
  id: "science_news",
  language: "de-DE",
  keywords: ["science"],
  blockedTerms: [],
  minIndependentSources: 2,
  maximumArticleAgeHours: 24,
  format: "briefing",
};
test("profile editor renders no forms until enabled and authenticated load succeeds", () => {
  const disabled = renderToStaticMarkup(<EditorialProfiles enabled={false} />);
  assert.match(disabled, /Profilverwaltung nicht freigeschaltet/);
  assert.doesNotMatch(disabled, /<form|<input|<select|science_news/);
  const enabled = renderToStaticMarkup(<EditorialProfiles enabled />);
  assert.match(enabled, /Lade Profile/);
  assert.doesNotMatch(enabled, /<form|<input|<select/);
});

test("only structurally valid and unique profile revisions enter the Admin UI", () => {
  assert.deepEqual(parseEditorialProfileSnapshot({ revision: 4, profiles: [profile] }), {
    revision: 4,
    profiles: [profile],
  });
  for (const candidate of [
    { revision: -1, profiles: [] },
    { revision: 1, profiles: [profile, profile] },
    { revision: 1, profiles: [{ ...profile, sourceToken: "private" }] },
    { revision: 1, profiles: [{ ...profile, language: "bad locale" }] },
  ]) {
    assert.equal(parseEditorialProfileSnapshot(candidate), null);
  }
});

test("audit export is disabled by default and never renders a file control", () => {
  const disabled = renderToStaticMarkup(<EditorialAuditExport enabled={false} />);
  assert.match(disabled, /Export noch nicht freigeschaltet/);
  assert.doesNotMatch(disabled, /<form|<input|<button/);
  const enabled = renderToStaticMarkup(<EditorialAuditExport enabled />);
  assert.match(enabled, /Vollständigen JSON-Export/);
  assert.match(enabled, /disabled/);
});

test("audit export envelope never accepts oversized or malformed rows", () => {
  assert.equal(validEditorialExportBatch({ events: [], nextRevision: 0 }), true);
  assert.equal(validEditorialExportBatch({ events: Array.from({ length: 101 }, () => ({})) }), false);
  assert.equal(validEditorialExportBatch({ events: ["forged string"] }), false);
});
