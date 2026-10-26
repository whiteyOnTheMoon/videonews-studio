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
    (prior.chain !== null && !SHA256.test(prior.chain))
  )
    return null;
  let revision = prior.revision;
  let chain = prior.chain;
  for (const entry of rows) {
    if (
      !object(entry) ||
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
      !Array.isArray(entry.reason_codes) ||
      entry.reason_codes.length < 1 ||
      entry.reason_codes.length > 20 ||
      entry.reason_codes.some(
        (code: unknown) => typeof code !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(code),
      ) ||
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
      typeof entry.event_id !== "string" ||
      !UUID.test(entry.event_id) ||
      typeof entry.actor_id !== "string" ||
      !UUID.test(entry.actor_id) ||
      !TIMELINE_KINDS.has(entry.event_kind as string) ||
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
