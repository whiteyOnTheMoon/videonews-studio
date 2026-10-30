const ID = /^[a-z][a-z0-9_-]{2,40}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
function obj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function range(v: unknown,min: number,max: number): boolean {
  return Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
}
export interface PublisherReviewWrite {
  sourceId: string;
  sourceRevision: number;
  publisherGroup: string;
  quality: number;
}
export interface EventFactorReviewWrite {
  eventId: string;
  profileId: string;
  profileRevision: number;
  policyRevision: number;
  explanatoryValue: number;
  visualizability: number;
  risk: number;
}
export interface PublisherReviewSnapshot {
  sourceId: string;
  sourceRevision: number;
  reviewed: boolean;
  publisherGroup: string | null;
  quality: number | null;
  approvedForPublication: false;
}
export interface EventFactorReviewSnapshot {
  eventId: string;
  profileId: string;
  profileRevision: number;
  policyRevision: number;
  reviewed: boolean;
  explanatoryValue: number | null;
  visualizability: number | null;
  risk: number | null;
  approvedForPublication: false;
}
export function validPublisherReviewWrite(v: unknown): v is PublisherReviewWrite {
  return obj(v) && Object.keys(v).sort().join(",") ===
    "publisherGroup,quality,sourceId,sourceRevision" &&
    typeof v.sourceId === "string" && ID.test(v.sourceId) &&
    typeof v.publisherGroup === "string" && ID.test(v.publisherGroup) &&
    range(v.sourceRevision,1,Number.MAX_SAFE_INTEGER) && range(v.quality,0,5);
}
export function validEventFactorReviewWrite(v: unknown): v is EventFactorReviewWrite {
  return obj(v) && Object.keys(v).sort().join(",") ===
    "eventId,explanatoryValue,policyRevision,profileId,profileRevision,risk,visualizability" &&
    typeof v.eventId === "string" && UUID.test(v.eventId) &&
    typeof v.profileId === "string" && ID.test(v.profileId) &&
    range(v.profileRevision,0,Number.MAX_SAFE_INTEGER) &&
    range(v.policyRevision,1,Number.MAX_SAFE_INTEGER) &&
    range(v.explanatoryValue,0,5) && range(v.visualizability,0,5) && range(v.risk,0,5);
}
export function validPublisherReviewSnapshot(v: unknown): v is PublisherReviewSnapshot {
  return obj(v) && Object.keys(v).sort().join(",") ===
    "approvedForPublication,publisherGroup,quality,reviewed,sourceId,sourceRevision" &&
    typeof v.sourceId === "string" && ID.test(v.sourceId) &&
    range(v.sourceRevision,1,Number.MAX_SAFE_INTEGER) &&
    typeof v.reviewed === "boolean" && v.approvedForPublication === false &&
    (v.reviewed
      ? typeof v.publisherGroup === "string" && ID.test(v.publisherGroup) &&
        range(v.quality,0,5)
      : v.publisherGroup === null && v.quality === null);
}
export function validEventFactorReviewSnapshot(v: unknown): v is EventFactorReviewSnapshot {
  return obj(v) && Object.keys(v).sort().join(",") ===
    "approvedForPublication,eventId,explanatoryValue,policyRevision,profileId,profileRevision,reviewed,risk,visualizability" &&
    typeof v.eventId === "string" && UUID.test(v.eventId) &&
    typeof v.profileId === "string" && ID.test(v.profileId) &&
    range(v.profileRevision,0,Number.MAX_SAFE_INTEGER) &&
    range(v.policyRevision,1,Number.MAX_SAFE_INTEGER) &&
    typeof v.reviewed === "boolean" && v.approvedForPublication === false &&
    (v.reviewed
      ? range(v.explanatoryValue,0,5) && range(v.visualizability,0,5) && range(v.risk,0,5)
      : v.explanatoryValue === null && v.visualizability === null && v.risk === null);
}
export function validMetadataReviewSaved(v: unknown): v is {
  saved: true;
  approvedForPublication: false;
} {
  return obj(v) && Object.keys(v).sort().join(",") === "approvedForPublication,saved" &&
    v.saved === true && v.approvedForPublication === false;
}
