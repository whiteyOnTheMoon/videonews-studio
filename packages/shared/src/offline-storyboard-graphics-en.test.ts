import assert from "node:assert/strict";
import test from "node:test";
import { makeOfflineGraphicStoryboard } from "./offline-storyboard-graphics.js";

const fixture = {
  storyId: "00000000-0000-4000-8000-000000000480",
  language: "en-US",
  scenes: [
    {
      kind: "text-card",
      title: "Earth and Climate",
      body: "Review required. Original graphics without third-party footage.",
      sourceUrls: ["https://www.noaa.gov/news-release/example"],
    },
  ],
};

test("renders an English-only preview footer while retaining all publication blockers", () => {
  const result = makeOfflineGraphicStoryboard(fixture);
  assert.equal(result.status, "PREVIEW_ONLY");
  assert.equal(result.videoRenderAllowed, false);
  assert.equal(result.uploadAllowed, false);
  assert.equal(result.sourcesVerified, false);
  assert.equal(result.frames.length, 1);
  assert.match(result.frames[0]!.svg, /PREVIEW – NOT FOR PUBLICATION/);
  assert.match(result.frames[0]!.svg, /ORIGINAL GRAPHIC/);
  assert.match(result.frames[0]!.svg, /Source links: 1 \(unverified\)/);
  assert.doesNotMatch(result.frames[0]!.svg, /VORSCHAU|Quellenlinks|Nicht veröffentlichte/);
});

test("rejects unrecognized locale without generating any frames", () => {
  const result = makeOfflineGraphicStoryboard({ ...fixture, language: "fr-FR" });
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.frames, []);
  assert.ok(result.errors.includes("invalid_language"));
});
