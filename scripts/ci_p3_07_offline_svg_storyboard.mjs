#!/usr/bin/env node
// Only disposable CI may write synthetic preview SVGs. Never run on VPS.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeOfflineGraphicStoryboard } from "../packages/shared/dist/offline-storyboard-graphics.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("REFUSED: synthetic graphics smoke is GitHub Actions only");
}

const sources = ["https://example.invalid/synthetic-news/123"];
const preview = makeOfflineGraphicStoryboard({
  storyId: "00000000-0000-4000-8000-000000000901",
  scenes: [
    {
      kind: "text-card",
      title: "Synthetische Nachrichtenvorschau",
      body: "Eigene Grafik statt fremder Videoclips. Alle Aussagen sind nur Testdaten.",
      sourceUrls: sources,
    },
    {
      kind: "table",
      title: "Synthetischer Wertevergleich",
      columns: ["Kennzahl", "Testwert"],
      rows: [
        ["Datensatz A", "12"],
        ["Datensatz B", "24"],
      ],
      sourceUrls: sources,
    },
    {
      kind: "timeline",
      title: "Synthetischer Zeitverlauf",
      entries: [
        { label: "Schritt 1", detail: "Erste Datenerfassung" },
        { label: "Schritt 2", detail: "Zweite Datenerfassung" },
      ],
      sourceUrls: sources,
    },
    {
      kind: "chart",
      title: "Synthetisches Vergleichsdiagramm",
      bars: [
        { label: "Messwert A", value: 12 },
        { label: "Messwert B", value: 24 },
      ],
      sourceUrls: sources,
    },
    {
      kind: "map",
      title: "Schematische Positionen",
      locations: [
        { label: "Testpunkt A", x: 20, y: 30 },
        { label: "Testpunkt B", x: 75, y: 60 },
      ],
      sourceUrls: sources,
    },
  ],
});
assert.equal(preview.status, "PREVIEW_ONLY");
assert.equal(preview.frames.length, 5);
assert.equal(preview.videoRenderAllowed, false);
assert.equal(preview.uploadAllowed, false);
assert.equal(preview.sourcesVerified, false);

const temporaryDirectory = await mkdtemp(join(tmpdir(), "vns-p3-07-preview-"));
try {
  for (const frame of preview.frames) {
    const name = "scene-" + String(frame.index + 1).padStart(2, "0") + ".svg";
    await writeFile(join(temporaryDirectory, name), frame.svg, { encoding: "utf8", mode: 0o600 });
  }
  const files = (await readdir(temporaryDirectory)).sort();
  assert.equal(files.length, 5);
  for (const file of files) {
    const content = await readFile(join(temporaryDirectory, file), "utf8");
    assert.match(content, /^<svg /);
    assert.ok(content.endsWith("</svg>"));
    assert.ok(content.includes("VORSCHAU – NICHT ZUR VERÖFFENTLICHUNG"));
    assert.doesNotMatch(content, /<image\b|<script\b|<foreignObject\b|<a\b/);
  }
  console.log("P3-07 PASS: five isolated synthetic SVG preview files; video render/upload denied.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
