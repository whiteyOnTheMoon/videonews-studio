// P1-07: CI-only, read-only pre-restart PostgreSQL/BullMQ inspection.
// Never enqueues, replays, acknowledges, consumes or marks work completed.
// The snapshot is NOT an authorization to resume workers or external publishing.
import assert from "node:assert/strict";

const LIMIT = 50;
const INVENTORY_STATES = [
  "waiting",
  "paused",
  "delayed",
  "active",
  "waiting-children",
  "completed",
  "failed",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOB_KINDS = new Set(["research", "script", "render", "upload"]);
const PG_STATES = new Set(["pending", "running", "retry", "done", "failed", "cancelled"]);
const BULL_STATES = new Set([
  "waiting",
  "delayed",
  "active",
  "paused",
  "waiting-children",
  "completed",
  "failed",
  "unknown",
]);

function ciOnly(pool, queue) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.CI !== "true" ||
    process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
    process.env.VNS_CI_RECOVERY_AUDIT !== "true" ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
  ) {
    throw new Error("REFUSED: disposable GitHub Actions reconciliation only");
  }
  if (
    pool?.options?.host !== "127.0.0.1" ||
    Number(pool?.options?.port) !== 15432 ||
    pool?.options?.user !== "vns_ci_recovery_reader" ||
    pool?.options?.database !== "videonews" ||
    queue?.name !== "vns-jobs" ||
    queue?.opts?.prefix !== "bull:vns"
  ) {
    throw new Error("REFUSED: only synthetic, separate read-only queue/DB connections");
  }
}

/**
 * Observe a bounded PostgreSQL snapshot and matching BullMQ job IDs.
 * BullMQ is not part of the database transaction; any mismatch blocks
 * restart and requires independent operator investigation.
 *
 * Coverage is bounded: checks both PG-known IDs and Redis jobs in supported
 * BullMQ states. It CANNOT prove completeness of removed/expired history,
 * duplicate external side effects, or jobs in unknown Redis key families.
 */
export async function inspectCiRecovery(pool, queue, limit = LIMIT) {
  ciOnly(pool, queue);
  assert.ok(Number.isInteger(limit) && limit > 0 && limit <= LIMIT, "Invalid CI audit row limit");
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transaction = true;
    const identity = await client.query("SELECT session_user, current_user");
    assert.equal(identity.rows[0]?.session_user, "vns_ci_recovery_reader");
    assert.equal(identity.rows[0]?.current_user, "vns_ci_recovery_reader");

    const result = await client.query(
      `SELECT j.id::text AS job_id, j.kind, j.status,
              ob.queue_job_id, ob.delivery_state, ob.dispatch_attempts
       FROM vns.jobs AS j JOIN vns.job_outbox AS ob ON ob.job_id=j.id
       ORDER BY j.created_at, j.id
       LIMIT $1`,
      [limit + 1],
    );
    assert.ok(result.rowCount <= limit, "CI audit cap exceeded; cannot claim full coverage");
    const records = [];
    for (const row of result.rows) {
      assert.ok(UUID.test(row.job_id), "Invalid PostgreSQL UUID");
      assert.equal(row.queue_job_id, "job-" + row.job_id.replaceAll("-", ""));
      assert.ok(JOB_KINDS.has(row.kind) && PG_STATES.has(row.status));
      assert.ok(["pending", "enqueued"].includes(row.delivery_state));
      assert.ok(Number.isSafeInteger(row.dispatch_attempts) && row.dispatch_attempts >= 0);
      const observed = await queue.getJob(row.queue_job_id);
      let bullState = null;
      let category;
      if (!observed) {
        category =
          row.delivery_state === "pending" ? "pending_without_redis" : "missing_enqueued_redis";
      } else {
        assert.equal(observed.id, row.queue_job_id);
        if (
          observed.name !== row.kind ||
          observed.data?.kind !== row.kind ||
          observed.data?.jobId !== row.job_id ||
          Object.keys(observed.data ?? {}).length !== 2
        ) {
          category = "queue_payload_conflict";
        } else {
          bullState = await observed.getState();
          assert.ok(BULL_STATES.has(bullState), "Unknown BullMQ state");
          if (bullState === "unknown") category = "transient_unknown_queue_state";
          else if (
            ["done", "failed", "cancelled"].includes(row.status) &&
            !["completed", "failed"].includes(bullState)
          ) {
            category = "terminal_postgres_job_still_runnable";
          } else if (
            ["pending", "running", "retry"].includes(row.status) &&
            ["completed", "failed"].includes(bullState)
          ) {
            category = "redis_terminal_postgres_nonterminal";
          } else if (row.status === "running" && bullState !== "active") {
            category = "postgres_running_but_queue_not_active";
          } else if (row.delivery_state === "pending") {
            category = "redis_ahead_of_outbox_ack";
          } else {
            category = "observed_matching_intent";
          }
        }
      }
      records.push({
        jobId: row.job_id,
        pgStatus: row.status,
        deliveryState: row.delivery_state,
        bullState,
        category,
      });
    }
    // Inventory the opposite direction as well. Without it, a Redis-only
    // job with no PostgreSQL source-of-truth row would remain invisible.
    // The cap and count agreement fail closed; never silently truncate.
    const counts = await queue.getJobCounts(...INVENTORY_STATES);
    assert.ok(counts !== null && typeof counts === "object");
    const total = INVENTORY_STATES.reduce((count, state) => {
      assert.ok(Number.isSafeInteger(counts[state]) && counts[state] >= 0);
      return count + counts[state];
    }, 0);
    assert.ok(total <= limit, "CI Redis inventory exceeds cap");
    const inventory = await queue.getJobs(INVENTORY_STATES, 0, limit, true);
    assert.ok(
      Array.isArray(inventory) && inventory.length === total,
      "Redis inventory changed or is incomplete",
    );
    const knownIds = new Set(result.rows.map((row) => row.queue_job_id));
    const inventoryIds = new Set();
    for (const job of inventory) {
      assert.ok(typeof job?.id === "string" && job.id.length <= 100);
      assert.ok(!inventoryIds.has(job.id), "Duplicate Redis inventory ID");
      inventoryIds.add(job.id);
      if (!knownIds.has(job.id)) {
        const state = await job.getState();
        assert.ok(BULL_STATES.has(state), "Unexpected orphan Redis state");
        records.push({
          jobId: job.id,
          pgStatus: null,
          deliveryState: null,
          bullState: state,
          category: /^job-[0-9a-f]{32}$/.test(job.id)
            ? "orphan_redis_job"
            : "unknown_redis_queue_id",
        });
      }
    }

    await client.query("COMMIT");
    transaction = false;

    // All results are actionable reports, NEVER "safe to restart" approval.
    const risk = new Set([
      "missing_enqueued_redis",
      "queue_payload_conflict",
      "transient_unknown_queue_state",
      "terminal_postgres_job_still_runnable",
      "redis_terminal_postgres_nonterminal",
      "postgres_running_but_queue_not_active",
      "orphan_redis_job",
      "unknown_redis_queue_id",
    ]);
    return {
      inspected: result.rows.length,
      redisInspected: inventory.length,
      hasConflicts: records.some((row) => risk.has(row.category)),
      operatorApprovalRequired: true,
      scope: "bounded_postgres_and_bullmq_inventory",
      records,
    };
  } catch {
    if (transaction) await client.query("ROLLBACK").catch(() => undefined);
    throw new Error("CI recovery inspection failed closed");
  } finally {
    client.release();
  }
}
