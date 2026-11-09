import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEarthClimateExplainedStructure,
  EARTH_CLIMATE_EXPLAINED_SECTION_IDS,
} from "./explained-script-structure.js";

function validDraft() {
  return {
    format: "earth-climate-explained",
    language: "en-US",
    sections: EARTH_CLIMATE_EXPLAINED_SECTION_IDS.map((id) => ({
      id,
      narration: "Original English narration for " + id + ".",
    })),
  };
}

test("accepts all seven canonical sections with no fixed duration fields", () => {
  const draft = validDraft();
  assert.doesNotThrow(() => assertEarthClimateExplainedStructure(draft));
  assert.equal(draft.sections.length, 7);
  assert.equal(Object.hasOwn(draft.sections[0]!, "seconds"), false);
});

test("rejects missing or additional sections", () => {
  assert.throws(() =>
    assertEarthClimateExplainedStructure({
      ...validDraft(),
      sections: validDraft().sections.slice(0, 6),
    }),
  );
  assert.throws(() =>
    assertEarthClimateExplainedStructure({
      ...validDraft(),
      sections: [...validDraft().sections, validDraft().sections[0]],
    }),
  );
});

test("rejects swapped or duplicated section identities", () => {
  const swapped = validDraft();
  const first = swapped.sections[0]!;
  swapped.sections[0] = swapped.sections[1]!;
  swapped.sections[1] = first;
  assert.throws(() => assertEarthClimateExplainedStructure(swapped));

  const repeated = validDraft();
  repeated.sections[2] = repeated.sections[1]!;
  assert.throws(() => assertEarthClimateExplainedStructure(repeated));
});

test("rejects blank narration and wrong language", () => {
  const blank = validDraft();
  blank.sections[1] = { ...blank.sections[1]!, narration: "  " };
  assert.throws(() => assertEarthClimateExplainedStructure(blank));
  assert.throws(() => assertEarthClimateExplainedStructure({ ...validDraft(), language: "de-DE" }));
});

test("rejects non-object and malformed sections", () => {
  assert.throws(() => assertEarthClimateExplainedStructure(null));
  assert.throws(() =>
    assertEarthClimateExplainedStructure({
      ...validDraft(),
      sections: [null, ...validDraft().sections.slice(1)],
    }),
  );
});
