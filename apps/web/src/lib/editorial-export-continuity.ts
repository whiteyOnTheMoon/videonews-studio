const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STAGES = new Set(["ranking", "claim_review", "freshness", "script_revision", "quality"]);
const OUTCOMES = new Set(["candidate", "blocked", "needs_review"]);
const TIMELINE_KINDS = new Set([
  "source",
  "claim",
  "claim_rejected",
  "review",
  "script_revision",
  "decision",
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
const CHECKPOINT_KEYS = [
  "revision",
  "stage",
  "outcome",
  "actor_id",
  "artifact_sha256",
  "reason_codes",
  "score",
  "previous_sha256",
  "chain_sha256",
  "recorded_at",
] as const;
const TIMELINE_KEYS = [
  "event_id",
  "event_kind",
  "actor_id",
  "reference_uri",
  "document_sha256",
  "details",
  "recorded_at",
] as const;
const REASON = /^[a-z][a-z0-9_]{1,39}$/;
const HTTPS_REFERENCE = /^https:\/\/[a-z0-9.-]+(?::443)?\/[a-zA-Z0-9/._~-]*$/;

function validReasons(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 20 &&
    value.every((code: unknown) => typeof code === "string" && REASON.test(code))
  );
}

function isoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export interface CheckpointPageCursor {
  revision: number;
  chain: string | null;
}

export interface TimelinePageCursor {
  afterTime: string;
  afterId: string;
}

/** Fail closed on duplicate, skipped or rearranged checkpoint revisions. */
export function verifyCheckpointPage(
  rows: readonly unknown[],
  prior: CheckpointPageCursor,
  nextRevision: unknown,
): CheckpointPageCursor | null {
  if (
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > 100 ||
    !Number.isSafeInteger(prior.revision) ||
    prior.revision < 0 ||
    (prior.chain !== null && !SHA256.test(prior.chain)) ||
    (prior.revision === 0 && prior.chain !== null) ||
    (prior.revision > 0 && prior.chain === null)
  )
    return null;
  let revision = prior.revision;
  let chain = prior.chain;
  for (const entry of rows) {
    if (
      !object(entry) ||
      !exactKeys(entry, CHECKPOINT_KEYS) ||
      entry.revision !== ++revision ||
      !STAGES.has(entry.stage as string) ||
      !OUTCOMES.has(entry.outcome as string) ||
      typeof entry.actor_id !== "string" ||
      !UUID.test(entry.actor_id) ||
      typeof entry.artifact_sha256 !== "string" ||
      !SHA256.test(entry.artifact_sha256) ||
      typeof entry.previous_sha256 !== "string" ||
      !SHA256.test(entry.previous_sha256) ||
      typeof entry.chain_sha256 !== "string" ||
      !SHA256.test(entry.chain_sha256) ||
      (chain !== null && entry.previous_sha256 !== chain) ||
      (chain === null && entry.previous_sha256 !== "0".repeat(64)) ||
      !validReasons(entry.reason_codes) ||
      !isoTime(entry.recorded_at) ||
      (entry.score !== null &&
        (!Number.isSafeInteger(entry.score) ||
          (entry.score as number) < 0 ||
          (entry.score as number) > 1000))
    )
      return null;
    chain = entry.chain_sha256 as string;
  }
  return nextRevision === revision ? { revision, chain } : null;
}

/**
 * Only verifies page ordering and cursor continuity, not independent
 * authenticity of a database reply or its signatures.
 */
export function verifyTimelinePage(
  rows: readonly unknown[],
  previous: TimelinePageCursor | null,
  next: unknown,
): TimelinePageCursor | null {
  if (
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > 100 ||
    (previous !== null && (!UUID.test(previous.afterId) || !isoTime(previous.afterTime)))
  )
    return null;
  let cursor = previous;
  for (const entry of rows) {
    if (
      !object(entry) ||
      !exactKeys(entry, TIMELINE_KEYS) ||
      typeof entry.event_id !== "string" ||
      !UUID.test(entry.event_id) ||
      typeof entry.actor_id !== "string" ||
      !UUID.test(entry.actor_id) ||
      !TIMELINE_KINDS.has(entry.event_kind as string) ||
      (entry.reference_uri !== null &&
        (typeof entry.reference_uri !== "string" ||
          entry.reference_uri.length > 2048 ||
          !HTTPS_REFERENCE.test(entry.reference_uri))) ||
      (entry.document_sha256 !== null &&
        (typeof entry.document_sha256 !== "string" || !SHA256.test(entry.document_sha256))) ||
      !object(entry.details) ||
      !exactKeys(entry.details, ["summary", "reasonCodes"]) ||
      typeof entry.details.summary !== "string" ||
      entry.details.summary.length < 8 ||
      entry.details.summary.length > 2000 ||
      [...entry.details.summary].some((char: string) => char.charCodeAt(0) < 32) ||
      !validReasons(entry.details.reasonCodes) ||
      !isoTime(entry.recorded_at) ||
      (cursor !== null &&
        (entry.recorded_at as string) <= cursor.afterTime &&
        (entry.recorded_at !== cursor.afterTime || (entry.event_id as string) <= cursor.afterId))
    )
      return null;
    cursor = { afterTime: entry.recorded_at as string, afterId: entry.event_id as string };
  }
  if (!object(next) || next.afterTime !== cursor?.afterTime || next.afterId !== cursor?.afterId) {
    return null;
  }
  return cursor;
}
