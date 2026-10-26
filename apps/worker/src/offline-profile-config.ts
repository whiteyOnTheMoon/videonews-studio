import { validateEditorialProfile, type EditorialProfile } from "./offline-editorial-pipeline.js";

/**
 * Runtime-independent P2-09 configuration input. No defaults, network or
 * activation. Profiles are supplied by an operator-owned future admin store.
 */
export function parseOfflineEditorialProfiles(json: string): readonly EditorialProfile[] {
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > 32768) {
    throw new Error("Editorial profile configuration too large");
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("Editorial profile configuration invalid");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Editorial profile configuration invalid");
  }
  const obj = data as Record<string, unknown>;
  if (Object.keys(obj).length !== 2 || obj.version !== 1 || !Array.isArray(obj.profiles)) {
    throw new Error("Editorial profile configuration invalid");
  }
  if (obj.profiles.length < 1 || obj.profiles.length > 20) {
    throw new Error("Editorial profile count invalid");
  }
  const ids = new Set<string>();
  return Object.freeze(obj.profiles.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Editorial profile invalid");
    }
    const entry = raw as Record<string, unknown>;
    const keys = ["id", "language", "keywords", "blockedTerms",
      "minIndependentSources", "maximumArticleAgeHours", "format"];
    if (Object.keys(entry).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(entry, key))) {
      throw new Error("Editorial profile fields invalid");
    }
    const profile = validateEditorialProfile(entry as unknown as EditorialProfile);
    if (ids.has(profile.id)) throw new Error("Duplicate editorial profile identity");
    ids.add(profile.id);
    return Object.freeze({
      ...profile,
      keywords: Object.freeze([...profile.keywords]),
      blockedTerms: Object.freeze([...profile.blockedTerms]),
    });
  }));
}

export function selectOfflineEditorialProfile(
  profiles: readonly EditorialProfile[],
  id: string,
): EditorialProfile {
  const matched = profiles.filter((profile) => profile.id === id);
  if (matched.length !== 1) throw new Error("Editorial profile not uniquely configured");
  return matched[0]!;
}
