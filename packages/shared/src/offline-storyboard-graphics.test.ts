import assert from "node:assert/strict";
import test from "node:test";
import { makeOfflineGraphicStoryboard } from "./offline-storyboard-graphics.js";

const STORY = "00000000-0000-4000-8000-000000000501";
const SOURCE = "https://example.invalid/news/synthetic-story";
const sources = [SOURCE];

const sceneSet = [
  {
    kind: "text-card",
    title: "Synthese einer Nachricht",
    body: "Eine redaktionell noch ungeprüfte Zusammenfassung nur für die interne Visualisierung.",
    sourceUrls: sources,
  },
  {
    kind: "table",
    title: "Vergleich der Messwerte",
    columns: ["Messpunkt", "Beispielwert"],
    rows: [
      ["A", "5 Einheiten"],
      ["B", "11 Einheiten"],
    ],
    sourceUrls: sources,
  },
  {
    kind: "timeline",
    title: "Chronologie des Beispiels",
    entries: [
      { label: "Phase 1", detail: "Eine neue Beobachtung" },
      { label: "Phase 2", detail: "Eine zweite Beobachtung" },
      { label: "Phase 3", detail: "Redaktionelle Prüfung ausstehend" },
    ],
    sourceUrls: sources,
  },
  {
    kind: "chart",
    title: "Synthetische Diagrammdaten",
    bars: [
      { label: "Referenzwert", value: 18 },
      { label: "Zweiter Wert", value: 52 },
      { label: "Nullwert", value: 0 },
    ],
    sourceUrls: sources,
  },
  {
    kind: "map",
    title: "Schematische Lagepunkte",
    locations: [
      { label: "Punkt A", x: 10, y: 15 },
      { label: "Punkt B", x: 70, y: 50 },
    ],
    sourceUrls: sources,
  },
];

test("creates five real SVG preview frames from fully synthetic input without footage", () => {
  const input = { storyId: STORY, scenes: sceneSet };
  const storyboard = makeOfflineGraphicStoryboard(input);
  assert.equal(storyboard.status, "PREVIEW_ONLY");
  assert.equal(storyboard.storyId, STORY);
  assert.deepEqual(storyboard.errors, []);
  assert.equal(storyboard.frames.length, 5);
  assert.deepEqual(
    storyboard.frames.map((frame) => frame.kind),
    ["text-card", "table", "timeline", "chart", "map"],
  );
  for (const [index, frame] of storyboard.frames.entries()) {
    assert.equal(frame.index, index);
    assert.equal(frame.sourceCount, 1);
    assert.match(frame.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(frame.svg.endsWith("</svg>"));
    assert.ok(frame.svg.includes("VORSCHAU – NICHT ZUR VERÖFFENTLICHUNG"));
    assert.ok(frame.svg.includes("Quellenlinks: 1 (ungeprüft)"));
    assert.doesNotMatch(frame.svg, /<image\b|<foreignObject\b|<script\b|xlink:href|<a\b/);
  }
  assert.ok(storyboard.frames[4]!.svg.includes("keine verifizierte GIS-Karte"));
  assert.equal(storyboard.videoRenderAllowed, false);
  assert.equal(storyboard.uploadAllowed, false);
  assert.equal(storyboard.sourcesVerified, false);
  assert.deepEqual(storyboard, makeOfflineGraphicStoryboard(input));
});

test("malicious-looking text is escaped as text, not inserted as SVG markup", () => {
  const storyboard = makeOfflineGraphicStoryboard({
    storyId: STORY,
    scenes: [
      {
        kind: "text-card",
        title: 'Test <script>alert("x")</script>',
        body: "Werte: <img src=x onerror=alert(1)> & <b>nicht echt</b>",
        sourceUrls: sources,
      },
    ],
  });
  assert.equal(storyboard.status, "PREVIEW_ONLY");
  const svg = storyboard.frames[0]!.svg;
  assert.ok(svg.includes("&lt;script&gt;"));
  assert.ok(svg.includes("&lt;img"));
  assert.ok(svg.includes("&amp;"));
  assert.doesNotMatch(svg, /<script\b|<img\b|<b>/);
  assert.equal(storyboard.videoRenderAllowed, false);
});

test("rejects invalid story identity and unknown unsupported graphic kind atomically", () => {
  for (const input of [
    null,
    {},
    { storyId: "not-a-uuid", scenes: sceneSet },
    { storyId: STORY, scenes: [] },
    { storyId: STORY, scenes: Array.from({ length: 9 }, () => sceneSet[0]) },
    {
      storyId: STORY,
      scenes: [sceneSet[0], { kind: "video", title: "No render", sourceUrls: sources }],
    },
    { storyId: STORY, scenes: [null] },
  ]) {
    const result = makeOfflineGraphicStoryboard(input);
    assert.equal(result.status, "REJECTED", JSON.stringify(input));
    assert.equal(result.frames.length, 0);
    assert.ok(result.errors.length > 0);
    assert.equal(result.videoRenderAllowed, false);
    assert.equal(result.uploadAllowed, false);
  }
});

test("unverified, malformed or duplicate source URLs cannot produce a storyboard", () => {
  for (const sourceUrls of [
    [],
    null,
    ["http://example.invalid/news"],
    ["https://example.invalid@evil.invalid/news"],
    ["https://example.invalid/news#fragment"],
    ["https://example.invalid:8443/news"],
    [SOURCE, SOURCE],
    [SOURCE, SOURCE, SOURCE, SOURCE],
    ["https://example.invalid/s ome"],
  ]) {
    const result = makeOfflineGraphicStoryboard({
      storyId: STORY,
      scenes: [{ ...sceneSet[0], sourceUrls }],
    });
    assert.equal(result.status, "REJECTED", JSON.stringify(sourceUrls));
    assert.equal(result.frames.length, 0);
  }
});

test("invalid metrics, point coordinates, and narrative details are rejected", () => {
  const invalidScenes = [
    { ...sceneSet[1], rows: [["Only one"]] },
    { ...sceneSet[1], rows: [["A", "B"]] },
    { ...sceneSet[2], entries: [{ label: "Only one", detail: "Missing second" }] },
    {
      ...sceneSet[3],
      bars: [
        { label: "A", value: 2 },
        { label: "B", value: -1 },
      ],
    },
    {
      ...sceneSet[3],
      bars: [
        { label: "A", value: 2 },
        { label: "B", value: Number.NaN },
      ],
    },
    {
      ...sceneSet[3],
      bars: [
        { label: "A", value: 2 },
        { label: "B", value: Number.POSITIVE_INFINITY },
      ],
    },
    { ...sceneSet[4], locations: [{ label: "A", x: 101, y: 30 }] },
    { ...sceneSet[4], locations: [{ label: "A", x: 50, y: -5 }] },
    { ...sceneSet[0], body: "x".repeat(221) },
  ];
  for (const scene of invalidScenes) {
    const result = makeOfflineGraphicStoryboard({ storyId: STORY, scenes: [scene] });
    assert.equal(result.status, "REJECTED", JSON.stringify(scene));
    assert.equal(result.frames.length, 0);
  }
});

test("synthetic publisher approval fields are ignored and cannot grant video use", () => {
  const result = makeOfflineGraphicStoryboard({
    storyId: STORY,
    scenes: sceneSet,
    editorApproved: true,
    publisherApproved: true,
    videoRenderAllowed: true,
    uploadAllowed: true,
    approvedSources: true,
  });
  assert.equal(result.status, "PREVIEW_ONLY");
  assert.equal(result.videoRenderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  assert.equal(result.sourcesVerified, false);
});
