/**
 * Canonical editorial structure for Earth & Climate Explained.
 * Offline metadata/ordering check only. It does not review facts, evidence,
 * actual spoken language, duration, audio timing, or publishing rights.
 */
export const EARTH_CLIMATE_EXPLAINED_SECTION_IDS = [
  "hook",
  "basics",
  "what-happened",
  "why-is-it-happening",
  "why-it-matters",
  "whats-next",
  "takeaway",
] as const;

export type EarthClimateExplainedSectionId =
  (typeof EARTH_CLIMATE_EXPLAINED_SECTION_IDS)[number];

export interface EarthClimateExplainedSection {
  id: EarthClimateExplainedSectionId;
  narration: string;
}

export interface EarthClimateExplainedScript {
  format: "earth-climate-explained";
  language: "en-US";
  sections: readonly EarthClimateExplainedSection[];
}

/**
 * Enforce presence and order, deliberately without section time quotas.
 * Language metadata is validated, but actual language must be reviewed elsewhere.
 */
export function assertEarthClimateExplainedStructure(
  value: unknown,
): asserts value is EarthClimateExplainedScript {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Explained script must be an object");
  }
  const draft = value as Record<string, unknown>;
  if (draft.format !== "earth-climate-explained" || draft.language !== "en-US") {
    throw new Error("Explained script format or language invalid");
  }
  if (!Array.isArray(draft.sections) || draft.sections.length !== 7) {
    throw new Error("Explained script must have exactly seven sections");
  }
  for (const [index, expected] of EARTH_CLIMATE_EXPLAINED_SECTION_IDS.entries()) {
    const section: unknown = draft.sections[index];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new Error("Explained script section invalid");
    }
    const record = section as Record<string, unknown>;
    if (record.id !== expected) {
      throw new Error("Explained script section missing, duplicated, or out of order");
    }
    if (
      typeof record.narration !== "string" ||
      record.narration.trim().length === 0 ||
      record.narration !== record.narration.trim()
    ) {
      throw new Error("Explained script narration missing or blank");
    }
  }
}
