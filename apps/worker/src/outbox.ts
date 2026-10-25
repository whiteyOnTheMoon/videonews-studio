import { type Queue } from "bullmq";
import { type Pool, type PoolClient } from "pg";

// SQL intent + Redis delivery are not atomic together. The ledger retains
// the stable BullMQ job ID, and the reconciler retries after partial failure.
export interface OutboxDelivery {
  job_id: string;
  queue_job_id: string;
  kind: string;
  max_attempts: number;
  delivery_state: "pending" | "enqueued";
}

export interface DispatchResult {
  examined: number;
  newlyEnqueued: number;
}

const SELECT_PENDING = `
  SELECT ob.job_id::text AS job_id, ob.queue_job_id,
         j.kind, j.max_attempts, ob.delivery_state
  FROM vns.job_outbox ob
  JOIN vns.jobs j ON j.id = ob.job_id
  WHERE j.status IN ('pending', 'retry')
  ORDER BY ob.created_at, ob.job_id
  LIMIT $1
  FOR UPDATE OF ob SKIP LOCKED
`;

export function validateOutboxRow(row: OutboxDelivery): void {
  if (row.delivery_state !== "pending" && row.delivery_state !== "enqueued") {
    throw new Error("Outbox delivery state invalid");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.job_id)) {
    throw new Error("Outbox job UUID invalid");
  }
  if (row.queue_job_id !== "job-" + row.job_id.replaceAll("-", "")) {
    throw new Error("Outbox deterministic queue ID invalid");
  }
  // The only available editorial worker processes research. Never enqueue
  // script/render/upload into its shared queue: those handlers do not exist.
  if (row.kind !== "research") {
    throw new Error("Unsupported editorial queue job kind");
  }
  if (!Number.isInteger(row.max_attempts) || row.max_attempts < 1 || row.max_attempts > 20) {
    throw new Error("Outbox retry count invalid");
  }
}

// No producer is wired into the running preview. Only an explicitly started,
// separately approved dispatcher may invoke this function against real data.
export async function dispatchOutboxBatch(
  pool: Pool,
  queue: Queue,
  limit = 5,
): Promise<DispatchResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Outbox batch limit must be 1..10");
  }
  const client: PoolClient = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const result = await client.query<OutboxDelivery>(SELECT_PENDING, [limit]);
    let newlyEnqueued = 0;
    for (const row of result.rows) {
      validateOutboxRow(row);
      const current = await queue.getJob(row.queue_job_id);
      if (current) {
        if (
          current.name !== row.kind ||
          current.data?.kind !== row.kind ||
          current.data?.jobId !== row.job_id ||
          Object.keys(current.data ?? {}).length !== 2 ||
          current.opts.attempts !== row.max_attempts ||
          typeof current.opts.backoff !== "object" ||
          current.opts.backoff?.type !== "exponential" ||
          current.opts.backoff?.delay !== 1000 ||
          current.opts.removeOnComplete !== false ||
          current.opts.removeOnFail !== false
        ) {
          throw new Error("Existing Redis job conflicts with PostgreSQL outbox");
        }
      } else {
        await queue.add(
          row.kind,
          { kind: row.kind, jobId: row.job_id },
          {
            jobId: row.queue_job_id,
            attempts: row.max_attempts,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: false,
            removeOnFail: false,
          },
        );
        // A concurrent producer may have claimed the deterministic ID
        // between getJob() and add(). Never acknowledge an unchecked collision.
        const persisted = await queue.getJob(row.queue_job_id);
        if (
          !persisted ||
          persisted.name !== row.kind ||
          persisted.data?.kind !== row.kind ||
          persisted.data?.jobId !== row.job_id ||
          Object.keys(persisted.data ?? {}).length !== 2 ||
          persisted.opts.attempts !== row.max_attempts ||
          typeof persisted.opts.backoff !== "object" ||
          persisted.opts.backoff?.type !== "exponential" ||
          persisted.opts.backoff?.delay !== 1000 ||
          persisted.opts.removeOnComplete !== false ||
          persisted.opts.removeOnFail !== false
        ) {
          throw new Error("Enqueued Redis job conflicts with PostgreSQL outbox");
        }
        newlyEnqueued += 1;
      }
      await client.query(
        `UPDATE vns.job_outbox
         SET delivery_state = 'enqueued',
             enqueued_at = COALESCE(enqueued_at, clock_timestamp()),
             last_attempt_at = clock_timestamp(),
             dispatch_attempts = dispatch_attempts + 1
         WHERE job_id = $1::uuid`,
        [row.job_id],
      );
    }
    await client.query("COMMIT");
    inTransaction = false;
    return { examined: result.rows.length, newlyEnqueued };
  } catch {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Fail closed; never log credentials or transport internals.
      }
    }
    throw new Error("Outbox delivery failed; safe to retry with stable job IDs");
  } finally {
    client.release();
  }
}
