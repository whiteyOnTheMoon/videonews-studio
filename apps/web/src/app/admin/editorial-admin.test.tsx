import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import EditorialProfiles, { parseEditorialProfileSnapshot } from "./editorial-profiles";
import EditorialAuditExport, {
  validEditorialExportBatch,
  validEditorialExportTerminator,
} from "./editorial-audit-export";
import EditorialCheckpointEntry from "./editorial-checkpoint-entry";
import EditorialTimelineEntry from "./editorial-timeline-entry";

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

test("audit export envelope rejects missing or forged page metadata", () => {
  const checkpoint = { events: [], nextRevision: 0 };
  const timeline = { events: [], cursor: null };
  assert.equal(validEditorialExportBatch(checkpoint, "checkpoints"), true);
  assert.equal(validEditorialExportBatch(timeline, "timeline"), true);
  for (const bad of [
    { events: [], nextRevision: 0, leakedSecret: "forbidden" },
    { events: [], nextRevision: -1 },
    { events: [], nextRevision: 1.5 },
    { events: [], cursor: null },
    { events: ["forged string"], nextRevision: 0 },
    { events: Array.from({ length: 101 }, () => ({})), nextRevision: 0 },
  ]) {
    assert.equal(validEditorialExportBatch(bad, "checkpoints"), false);
  }
  for (const bad of [
    { events: [] },
    { events: [], cursor: {} },
    { events: [], cursor: null, extra: "unreviewed" },
    { events: [], cursor: { afterTime: "not-a-time", afterId: "invalid" } },
    { events: Array.from({ length: 101 }, () => ({})), cursor: null },
  ]) {
    assert.equal(validEditorialExportBatch(bad, "timeline"), false);
  }
});

test("checkpoint entry is hidden until feature opt-in and never publishes", () => {
  const hidden = renderToStaticMarkup(<EditorialCheckpointEntry enabled={false} />);
  assert.match(hidden, /Prüfprotokoll nicht freigeschaltet/);
  assert.doesNotMatch(hidden, /<form|<input|<select/);
  const active = renderToStaticMarkup(<EditorialCheckpointEntry enabled />);
  assert.match(active, /Ereignis-UUID/);
  assert.match(active, /Qualität/);
  assert.match(active, /Prüfentscheidung speichern/);
  assert.doesNotMatch(active, /veröffentlichen|Upload starten|Freigabe erteilen/i);
});

test("Story audit entry shows no form by default and no publishing controls", () => {
  const dormant = renderToStaticMarkup(<EditorialTimelineEntry enabled={false} />);
  assert.match(dormant, /Story-Protokoll nicht freigeschaltet/);
  assert.doesNotMatch(dormant, /<form|<input|<textarea/);
  const enabled = renderToStaticMarkup(<EditorialTimelineEntry enabled />);
  assert.match(enabled, /Abgelehnte Aussage/);
  assert.match(enabled, /Story-Ereignis speichern/);
  assert.doesNotMatch(enabled, /Jetzt veröffentlichen/);
});

test("audit export terminator never accepts changed checkpoint cursor or nonempty timeline cursor", () => {
  const emptyCheckpoint = { events: [], nextRevision: 4 };
  assert.equal(validEditorialExportTerminator("checkpoints", emptyCheckpoint, 4), true);
  assert.equal(validEditorialExportTerminator("checkpoints", emptyCheckpoint, 3), false);
  assert.equal(validEditorialExportTerminator("checkpoints", { events: [{}], nextRevision: 4 }, 4), false);
  assert.equal(validEditorialExportTerminator("timeline", { events: [], cursor: null }, 0), true);
  assert.equal(
    validEditorialExportTerminator(
      "timeline",
      {
        events: [],
        cursor: {
          afterTime: "2026-10-26T12:00:00.000Z",
          afterId: "ca310001-1111-4111-8111-111111111111",
        },
      },
      0,
    ),
    false,
  );
});
