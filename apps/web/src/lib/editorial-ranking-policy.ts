const ID = /^[a-z][a-z0-9_-]{2,40}$/;
export interface RankingPolicySettings {
  minimumPublisherGroups: number;
  relevanceWeight: number;
  freshnessWeight: number;
  qualityWeight: number;
  explanatoryWeight: number;
  visualizabilityWeight: number;
  riskWeight: number;
  maximumRisk: number;
}
const FIELDS = [
  "minimumPublisherGroups",
  "relevanceWeight",
  "freshnessWeight",
  "qualityWeight",
  "explanatoryWeight",
  "visualizabilityWeight",
  "riskWeight",
  "maximumRisk",
] as const;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function validRankingPolicySettings(value: unknown): value is RankingPolicySettings {
  if (!object(value) || Object.keys(value).sort().join(",") !== [...FIELDS].sort().join(","))
    return false;
  return FIELDS.every((key) => {
    const n = value[key];
    const min = key === "minimumPublisherGroups" ? 2 : 0;
    const max = key === "minimumPublisherGroups" || key === "maximumRisk" ? 5 : 100;
    return Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max;
  });
}
export interface RankingPolicySnapshot {
  profileId: string;
  profileRevision: number;
  policyRevision: number;
  settings: RankingPolicySettings | null;
  productionActive: false;
}
export function validRankingPolicySnapshot(value: unknown): value is RankingPolicySnapshot {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !==
      "policyRevision,productionActive,profileId,profileRevision,settings" ||
    typeof value.profileId !== "string" ||
    !ID.test(value.profileId) ||
    !Number.isSafeInteger(value.profileRevision) ||
    (value.profileRevision as number) < 0 ||
    !Number.isSafeInteger(value.policyRevision) ||
    (value.policyRevision as number) < 0 ||
    value.productionActive !== false
  )
    return false;
  return (
    (value.policyRevision === 0 && value.settings === null) ||
    ((value.policyRevision as number) > 0 && validRankingPolicySettings(value.settings))
  );
}
export function validRankingPolicyCommit(value: unknown): value is {
  saved: true;
  policyRevision: number;
  productionActive: false;
} {
  return (
    object(value) &&
    Object.keys(value).sort().join(",") === "policyRevision,productionActive,saved" &&
    value.saved === true &&
    value.productionActive === false &&
    Number.isSafeInteger(value.policyRevision) &&
    (value.policyRevision as number) > 0
  );
}
