// CI only: recovery inspection on a separate readonly PostgreSQL LOGIN and
// disposable authenticated Redis. No editorial worker is started.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { inspectCiRecovery } from "./ci_outbox_recovery_audit.mjs";
import { QUEUE_NAME, QUEUE_PREFIX } from "../apps/worker/dist/queue.js";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CI !== "true" ||
  process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
  process.env.VNS_CI_RECOVERY_AUDIT !== "true" ||
  !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
) {
  throw new Error("REFUSED: GitHub Actions disposable recovery test only");
}
const file = process.env.VNS_TEST_REDIS_PASSWORD_FILE;
if (!file?.startsWith("/tmp/")) throw new Error("REFUSED: disposable Redis credentials required");

const { Pool } = pg;
const connection = {
  host: "127.0.0.1",
  port: 15432,
  database: "videonews",
  max: 2,
  connectionTimeoutMillis: 4000,
};
const owner = new Pool({
  ...connection,
  user: "vns",
  password: "ci-outbox-test-only-not-a-real-secret",
});
const role = "vns_ci_recovery_reader";
const password = randomBytes(32).toString("hex");
const readOnly = new Pool({ ...connection, user: role, password });
const redis = new Redis({
  host: "127.0.0.1",
  port: 16379,
  username: "vns_worker",
  password: readFileSync(file, "utf8").trimEnd(),
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
const queue = new Queue(QUEUE_NAME, { connection: redis, prefix: QUEUE_PREFIX });
let createdRole = false;
const queueId = (id) => "job-" + id.replaceAll("-", "");

async function create(key) {
  const result = await owner.query("SELECT vns.create_job_with_outbox('research', $1) AS id", [
    key,
  ]);
  return result.rows[0].id;
}
async function report() {
  const result = await inspectCiRecovery(readOnly, queue);
  assert.equal(result.operatorApprovalRequired, true);
  assert.equal(result.scope, "bounded_postgres_and_bullmq_inventory");
  return result;
}
async function row(id) {
  const r = await owner.query(
    `SELECT j.status,ob.delivery_state,ob.dispatch_attempts
       FROM vns.jobs j JOIN vns.job_outbox ob ON ob.job_id=j.id
       WHERE j.id=$1`,
    [id],
  );
  return r.rows[0];
}
async function addValid(id) {
  return queue.add(
    "research",
    { kind: "research", jobId: id },
    {
      jobId: queueId(id),
      attempts: 3,
      removeOnComplete: false,
      removeOnFail: false,
    },
  );
}
try {
  await owner.query(
    `CREATE ROLE vns_ci_recovery_reader LOGIN NOINHERIT NOSUPERUSER
     NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 2
     PASSWORD '${password}'`,
  );
  createdRole = true;
  // Do NOT inherit the dispatcher role: it has outbox UPDATE rights.
  // The separate CI recovery login gets strictly SELECT on just two tables.
  await owner.query("GRANT USAGE ON SCHEMA vns TO vns_ci_recovery_reader");
  await owner.query("GRANT SELECT ON vns.jobs, vns.job_outbox TO vns_ci_recovery_reader");
  const who = await readOnly.query("SELECT current_user, session_user");
  assert.equal(who.rows[0].session_user, role);
  await assert.rejects(
    readOnly.query("UPDATE vns.job_outbox SET delivery_state='pending'"),
    (error) => error?.code === "42501",
  );
  await assert.rejects(
    readOnly.query("SELECT username FROM vns.editor_accounts"),
    (error) => error?.code === "42501",
  );
  await assert.rejects(readOnly.query("SET ROLE vns"), (error) => error?.code === "42501");

  // Other CI tests have stopped all workers; reset only disposable fixtures.
  await queue.obliterate({ force: true });
  await owner.query("DELETE FROM vns.research_evidence");
  await owner.query("DELETE FROM vns.job_outbox");
  await owner.query("DELETE FROM vns.research_requests");
  await owner.query("DELETE FROM vns.jobs");

  let checked = await report();
  assert.equal(checked.inspected, 0);
  assert.equal(checked.hasConflicts, false);
  assert.equal(checked.operatorApprovalRequired, true);

  const id = await create("ci-recovery-readonly-00001");
  checked = await report();
  assert.equal(checked.inspected, 1);
  assert.equal(checked.records[0].category, "pending_without_redis");

  await addValid(id);
  checked = await report();
  assert.equal(checked.records[0].category, "redis_ahead_of_outbox_ack");

  await owner.query(
    `UPDATE vns.job_outbox SET delivery_state='enqueued',
      enqueued_at=clock_timestamp(),last_attempt_at=clock_timestamp(),
      dispatch_attempts=1 WHERE job_id=$1`,
    [id],
  );
  checked = await report();
  assert.equal(checked.records[0].category, "observed_matching_intent");
  assert.equal(checked.hasConflicts, false);

  await (await queue.getJob(queueId(id))).remove();
  checked = await report();
  assert.equal(checked.records[0].category, "missing_enqueued_redis");
  assert.equal(checked.hasConflicts, true);

  await queue.add("probe", { kind: "probe", jobId: id }, { jobId: queueId(id) });
  checked = await report();
  assert.equal(checked.records[0].category, "queue_payload_conflict");
  assert.equal(checked.hasConflicts, true);
  await (await queue.getJob(queueId(id))).remove();

  await addValid(id);
  await owner.query("UPDATE vns.jobs SET status='done' WHERE id=$1", [id]);
  checked = await report();
  assert.equal(checked.records[0].category, "terminal_postgres_job_still_runnable");
  assert.equal(checked.hasConflicts, true);
  await owner.query("UPDATE vns.jobs SET status='pending' WHERE id=$1", [id]);

  // A real Redis or PostgreSQL failure must stop the inspection, not guess.
  const offlineQueue = {
    name: QUEUE_NAME,
    opts: { prefix: QUEUE_PREFIX },
    getJob: async () => {
      throw new Error("synthetic Redis disconnect");
    },
  };
  await assert.rejects(
    inspectCiRecovery(readOnly, offlineQueue),
    /CI recovery inspection failed closed/,
  );
  const previousFlag = process.env.VNS_CI_RECOVERY_AUDIT;
  process.env.VNS_CI_RECOVERY_AUDIT = "false";
  try {
    await assert.rejects(inspectCiRecovery(readOnly, queue), /REFUSED/);
  } finally {
    process.env.VNS_CI_RECOVERY_AUDIT = previousFlag;
  }

  const before = await row(id);
  const redisCounts = await queue.getJobCounts("waiting", "completed", "failed");
  const repeated = await report();
  assert.equal(repeated.inspected, 1);
  assert.deepEqual(await row(id), before);
  assert.deepEqual(await queue.getJobCounts("waiting", "completed", "failed"), redisCounts);
  await create("ci-recovery-readonly-00002");
  await assert.rejects(inspectCiRecovery(readOnly, queue, 1), /failed closed/);
  await assert.rejects(inspectCiRecovery(readOnly, queue, 0), /Invalid CI audit row limit/);
  // A Redis job with a deterministic-looking ID but NO PostgreSQL job
  // must be reported, never treated as an authorized reconstruction.
  const orphanId = "job-" + "a".repeat(32);
  await queue.add(
    "research",
    { kind: "research", jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { jobId: orphanId, removeOnComplete: false },
  );
  let orphanReport = await report();
  assert.equal(orphanReport.redisInspected, 2);
  assert.equal(orphanReport.hasConflicts, true);
  assert.equal(
    orphanReport.records.find((record) => record.jobId === orphanId)?.category,
    "orphan_redis_job",
  );
  const unexpectedId = "ci-unexpected-queue-id";
  await queue.add("probe", { kind: "probe" }, { jobId: unexpectedId });
  orphanReport = await report();
  assert.equal(orphanReport.redisInspected, 3);
  assert.equal(
    orphanReport.records.find((record) => record.jobId === unexpectedId)?.category,
    "unknown_redis_queue_id",
  );
  await assert.rejects(inspectCiRecovery(readOnly, queue, 2), /failed closed/);
  assert.equal((await row(id)).status, before.status);
  assert.ok(await queue.getJob(orphanId));
  assert.ok(await queue.getJob(unexpectedId));

  console.log(
    "PASS: actual restricted PostgreSQL LOGIN sees PG/Redis mismatches without writes or replay",
  );
  console.log(
    "PASS: missing Redis, lost acknowledgement, collision, terminal conflict and disconnect fail closed",
  );
  console.log("PASS: orphan and nonstandard Redis-only job IDs fail closed");
  console.log("KNOWN LIMIT: bounded Redis states are not complete AOF or side-effect history");
} finally {
  await Promise.allSettled([readOnly.end(), queue.close()]);
  await redis.quit().catch(() => undefined);
  if (createdRole) {
    await owner
      .query("REVOKE SELECT ON vns.jobs, vns.job_outbox FROM vns_ci_recovery_reader")
      .catch(() => undefined);
    await owner
      .query("REVOKE USAGE ON SCHEMA vns FROM vns_ci_recovery_reader")
      .catch(() => undefined);
    await owner.query("DROP ROLE vns_ci_recovery_reader").catch(() => undefined);
  }
  await owner.end();
}
