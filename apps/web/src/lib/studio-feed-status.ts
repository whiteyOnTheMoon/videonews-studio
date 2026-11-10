/** Fail-closed UI shape for a personally authenticated P2 job witness. */
export interface StudioFeedStatus {
  jobId: string;
  state: "pending" | "unknown" | "failed" | "completed";
  finishedAt: string | null;
  summary: null | {
    sourcesExamined: number;
    candidatesAdded: number;
    notModified: number;
  };
  publishingAllowed: false;
}
const ID = /^vns-feed-tick-(0|[1-9][0-9]{0,13})$/;

export function validStudioFeedStatus(value: unknown, jobId: string): value is StudioFeedStatus {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "finishedAt,jobId,publishingAllowed,state,summary" ||
    !("jobId" in value) || value.jobId !== jobId ||
    !ID.test(jobId) ||
    !("publishingAllowed" in value) || value.publishingAllowed !== false ||
    !("state" in value) || !["pending","unknown","failed","completed"].includes(value.state as string) ||
    !("finishedAt" in value) || !("summary" in value)
  ) return false;
  if (value.state !== "completed") return value.finishedAt === null && value.summary === null;
  if (typeof value.finishedAt !== "string" ||
      !Number.isFinite(Date.parse(value.finishedAt)) ||
      new Date(value.finishedAt).toISOString() !== value.finishedAt) return false;
  const s = value.summary;
  if (!s || typeof s !== "object" || Array.isArray(s) ||
      Object.keys(s).sort().join(",") !== "candidatesAdded,notModified,sourcesExamined") return false;
  const row = s as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.sourcesExamined) || (row.sourcesExamined as number) < 0 ||
    (row.sourcesExamined as number) > 5 ||
    !Number.isSafeInteger(row.candidatesAdded) || (row.candidatesAdded as number) < 0 ||
    (row.candidatesAdded as number) > 10000 ||
    !Number.isSafeInteger(row.notModified) || (row.notModified as number) < 0 ||
    (row.notModified as number) > (row.sourcesExamined as number)
  ) return false;
  return true;
}
