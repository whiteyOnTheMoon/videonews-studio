import type { Queue, Job } from "bullmq";
import type { Pool, PoolClient } from "pg";

// Read-only Redis snapshots reconciled into the PostgreSQL editorial job ledger.
// This module never processes, retries, publishes or removes jobs.
export interface StatusCandidate {
  job_id: string;
  kind: string;
  queue_job_id: string;
  status: "pending" | "running" | "retry";
}

export type EditorialJobState = "pending" | "running" | "retry" | "done" | "failed";

export interface StatusSyncResult {
  examined: number;
  updated: number;
  missingRedis: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SELECT_JOBS = `
  SELECT j.id::text AS job_id, j.kind, ob.queue_job_id, j.status
  FROM vns.jobs AS j
  JOIN vns.job_outbox AS ob ON ob.job_id = j.id
  WHERE j.status IN ('pending', 'running', 'retry')
    AND ob.delivery_state = 'enqueued'
  ORDER BY j.created_at, j.id
  LIMIT $1
  FOR UPDATE OF j SKIP LOCKED
`;

export function validateCandidate(value: StatusCandidate): void {
  if (
    !UUID.test(value.job_id) ||
    value.queue_job_id !== "job-" + value.job_id.replaceAll("-", "")
  ) {
    throw new Error("Malformed persisted queue job identifier");
  }
  if (
    !["research", "script", "render", "upload"].includes(value.kind) ||
    !["pending", "running", "retry"].includes(value.status)
  ) {
    throw new Error("Unsupported editorial job type/state");
  }
}

export function mapBullState(bullState: string, attemptsMade: number): EditorialJobState | null {
  if (!Number.isSafeInteger(attemptsMade) || attemptsMade < 0 || attemptsMade > 20) {
    throw new Error("Invalid queue attempt count");
  }
  switch (bullState) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "active":
      return "running";
    case "delayed":
    case "waiting":
    case "waiting-children":
    case "paused":
      return attemptsMade > 0 ? "retry" : "pending";
    case "unknown":
      // A job may be removed between getJob and getState. Do not guess.
      return null;
    default:
      throw new Error("Unrecognized BullMQ state");
  }
}

function verifyRedisJob(job: Job, row: StatusCandidate): void {
  if (
    job.id !== row.queue_job_id ||
    job.name !== row.kind ||
    job.data?.kind !== row.kind ||
    job.data?.jobId !== row.job_id ||
    Object.keys(job.data ?? {}).length !== 2
  ) {
    throw new Error("Redis job conflicts with persisted editorial record");
  }
}

/**
 * A completed queue job means its BullMQ processor returned successfully;
 * not that a video was published. Failed jobs are terminal only once BullMQ
 * itself reports failed after exhausting retries.
 *
 * The transaction protects against concurrent DB reconciliation. Redis can
 * change while queried, so this is an eventual snapshot, not a cross-store
 * atomic transition. Terminal PostgreSQL states are never overwritten.
 */
export async function reconcileJobStatusBatch(
  pool: Pool,
  queue: Queue,
  limit = 5,
): Promise<StatusSyncResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Status batch limit must be 1..10");
  }
  const client: PoolClient = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const result = await client.query<StatusCandidate>(SELECT_JOBS, [limit]);
    let updated = 0;
    let missingRedis = 0;
    for (const row of result.rows) {
      validateCandidate(row);
      const job = await queue.getJob(row.queue_job_id);
      if (!job) {
        // Dispatcher can reconstruct a lost Redis job using the outbox intent.
        // Do not mark it successful or terminal from absence alone.
        missingRedis += 1;
        continue;
      }
      verifyRedisJob(job, row);
      const state = mapBullState(await job.getState(), job.attemptsMade);
      if (state === null) {
        missingRedis += 1;
        continue;
      }
      if (state === row.status && job.attemptsMade === 0) continue;

      const outcome = await client.query(
        `UPDATE vns.jobs
         SET status = $2,
             attempt_count = GREATEST(attempt_count, LEAST($3, max_attempts)),
             error_code = CASE
               WHEN $2 = 'failed' THEN 'bullmq_failed'
               ELSE NULL
             END
         WHERE id = $1::uuid
           AND status IN ('pending', 'running', 'retry')
           AND (status IS DISTINCT FROM $2
             OR attempt_count < LEAST($3, max_attempts)
             OR ($2 = 'failed' AND error_code IS DISTINCT FROM 'bullmq_failed'))
        `,
        [row.job_id, state, job.attemptsMade],
      );
      updated += outcome.rowCount ?? 0;
    }
    await client.query("COMMIT");
    inTransaction = false;
    return { examined: result.rows.length, updated, missingRedis };
  } catch {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Never leak Redis/PG secrets in error details.
      }
    }
    throw new Error("Editorial job status reconciliation failed");
  } finally {
    client.release();
  }
}
