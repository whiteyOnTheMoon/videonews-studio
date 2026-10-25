// CI-only: synthetic BullMQ research worker -> real PostgreSQL evidence ledger.
// No external network fetching, provider credentials, research, AI calls or publication.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import {
  createResearchProcessor,
  PostgresResearchEvidenceStore,
} from "../apps/worker/dist/research-process.js";
import { dispatchOutboxBatch } from "../apps/worker/dist/outbox.js";
import { createEditorialProcessor } from "../apps/worker/dist/editorial-process.js";
import { createDormantEditorialWorker } from "../apps/worker/dist/editorial-worker.js";
import { reconcileJobStatusBatch } from "../apps/worker/dist/job-status.js";
import { QUEUE_NAME, QUEUE_PREFIX } from "../apps/worker/dist/queue.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("Research processor integration is GitHub Actions only");
}
const passwordFile = process.env.VNS_TEST_REDIS_PASSWORD_FILE;
if (!passwordFile?.startsWith("/tmp/")) throw new Error("Missing CI-only Redis secret");
const connection = {
  host: "127.0.0.1",
  port: 16379,
  username: "vns_worker",
  password: readFileSync(passwordFile, "utf8").trimEnd(),
};
const producerRedis = new Redis({ ...connection, maxRetriesPerRequest: 1 });
const eventRedis = new Redis({ ...connection, maxRetriesPerRequest: null });
const queue = new Queue(QUEUE_NAME, { connection: producerRedis, prefix: QUEUE_PREFIX });
const events = new QueueEvents(QUEUE_NAME, { connection: eventRedis, prefix: QUEUE_PREFIX });
const { Pool } = pg;
const db = new Pool({
  host: "127.0.0.1",
  port: 15432,
  user: "vns",
  database: "videonews",
  password: "ci-outbox-test-only-not-a-real-secret",
  max: 2,
  connectionTimeoutMillis: 4000,
});
// These accounts are created only inside the disposable CI PostgreSQL service.
// The owner pool above is restricted to creating and inspecting CI fixtures.
const scoped = (user, password) =>
  new Pool({
    host: "127.0.0.1",
    port: 15432,
    user,
    password,
    database: "videonews",
    max: 2,
    connectionTimeoutMillis: 4000,
  });
const dispatchDb = scoped(
  "vns_outbox_dispatch_login",
  "ci-dispatch-fixture-only-not-a-real-secret-0001",
);
const statusDb = scoped(
  "vns_job_status_sync_login",
  "ci-status-fixture-only-not-a-real-secret-0002",
);
const researchDb = scoped(
  "vns_research_writer_login",
  "ci-research-fixture-only-not-a-real-secret-0003",
);
let worker;
let workerConnection;
const topic = "Municipal transport infrastructure and public accountability";
const candidate = {
  sourceUrl: "https://www.example.org/reports/mobility-2026",
  publisher: "Example Transport Institute",
  headline: "Mobility investment and accountability review",
  claim: "The report summarizes proposed infrastructure investments.",
};
const fetchedAt = "2026-10-23T18:30:00.000Z";
const document = {
  sourceUrl: candidate.sourceUrl,
  mediaType: "text/html",
  text: "CI fixture only: no actual website was accessed",
  fetchedAt,
  sha256: "a".repeat(64),
};
let searches = 0;
let fetches = 0;
const store = new PostgresResearchEvidenceStore(researchDb);
const researchHandler = createResearchProcessor(
  store,
  {
    async discover(foundTopic) {
      searches += 1;
      assert.equal(foundTopic, topic);
      return [candidate];
    },
  },
  {
    async fetch(url) {
      fetches += 1;
      assert.equal(url, candidate.sourceUrl);
      return document;
    },
  },
);
const processor = createEditorialProcessor(researchHandler);
// Exercise denial before any PostgreSQL/Redis work or source discovery.
for (const invalid of [
  { name: "render", id: "job-" + "0".repeat(32), data: { kind: "render" } },
  { name: "research", id: "job-" + "0".repeat(32), data: { kind: "research", jobId: "invalid" } },
]) {
  await assert.rejects(processor(invalid), /Unsupported editorial job envelope/);
}
assert.equal(searches, 0);
assert.equal(fetches, 0);
try {
  await events.waitUntilReady();
  await queue.waitUntilReady();
  // Fully disposable CI DB/Redis: isolate synthetic research from earlier test jobs.
  await queue.obliterate({ force: true });
  await db.query("DELETE FROM vns.research_evidence");
  await db.query("DELETE FROM vns.job_outbox");
  await db.query("DELETE FROM vns.research_requests");
  await db.query("DELETE FROM vns.jobs");
  // Fail closed before dispatch: each live-equivalent principal must be unable
  // to write into another service's ledger, even within the integrated chain.
  for (const [pool, statement] of [
    [dispatchDb, "UPDATE vns.jobs SET status='done' WHERE false"],
    [statusDb, "UPDATE vns.job_outbox SET delivery_state='pending' WHERE false"],
    [researchDb, "UPDATE vns.research_evidence SET review_status='verified' WHERE false"],
  ]) {
    await assert.rejects(pool.query(statement), (error) => error.code === "42501");
  }
  for (const pool of [dispatchDb, statusDb, researchDb]) {
    const result = await pool.query("SELECT current_user AS role");
    assert.notEqual(result.rows[0].role, "vns");
  }
  const key = "ci-research-proc-job-001";
  const created = await db.query("SELECT vns.create_research_request($1, $2) AS id", [key, topic]);
  const jobId = created.rows[0].id;
  // The test runner might still have earlier CI job fixtures; only require
  // that our deterministic ID appears, not that the batch inserted one.
  for (let i = 0; i < 10; i++) {
    await dispatchOutboxBatch(dispatchDb, queue, 10);
    if (await queue.getJob("job-" + jobId.replaceAll("-", ""))) break;
  }
  const queued = await queue.getJob("job-" + jobId.replaceAll("-", ""));
  assert.ok(queued);
  // The production factory is dormant until this disposable CI test explicitly runs it.
  ({ worker, connection: workerConnection } = createDormantEditorialWorker(
    { host: connection.host, port: connection.port, password: connection.password },
    true,
    researchHandler,
  ));
  assert.equal(worker.opts.autorun, false);
  assert.equal(worker.opts.concurrency, 1);
  worker.on("error", () => console.error("CI editorial worker error"));
  const running = worker.run();
  running.catch(() => console.error("CI editorial worker stopped"));
  await worker.waitUntilReady();
  const result = await queued.waitUntilFinished(events, 20000);
  assert.deepEqual(result, { candidatesRecorded: 1, needsEditorialReview: true });
  assert.equal(searches, 1);
  assert.equal(fetches, 1);
  let evidence = await db.query(
    `SELECT source_url, publisher, headline, claim_text, review_status,
            reviewer, reviewed_at, observed_at
     FROM vns.research_evidence WHERE job_id = $1`,
    [jobId],
  );
  assert.equal(evidence.rowCount, 1);
  assert.equal(evidence.rows[0].source_url, candidate.sourceUrl);
  assert.equal(evidence.rows[0].publisher, candidate.publisher);
  assert.equal(evidence.rows[0].headline, candidate.headline);
  assert.equal(evidence.rows[0].claim_text, candidate.claim);
  assert.equal(evidence.rows[0].review_status, "candidate");
  assert.equal(evidence.rows[0].reviewer, null);
  assert.equal(evidence.rows[0].reviewed_at, null);
  assert.equal(evidence.rows[0].observed_at.toISOString(), fetchedAt);
  assert.ok(!JSON.stringify(evidence.rows).includes(document.text));
  console.log(
    "PASS: synthetic BullMQ research job records exactly one unverified evidence candidate",
  );

  // A worker re-run after a stall may retrieve the same source again,
  // but must not overwrite its original provenance or duplicate the row.
  assert.deepEqual(await processor(queued), result);
  evidence = await db.query(
    "SELECT count(*)::int AS count FROM vns.research_evidence WHERE job_id = $1",
    [jobId],
  );
  assert.equal(evidence.rows[0].count, 1);

  // A human review verdict, once present, is never reset by a repeated
  // job (the processing step is not an editorial authorization mechanism).
  await db.query(
    `UPDATE vns.research_evidence
     SET review_status='verified', reviewer='ci-editor',
         review_reason='The synthetic report directly supports this test-only finding.',
         reviewed_at=clock_timestamp()
     WHERE job_id=$1`,
    [jobId],
  );
  assert.deepEqual(await processor(queued), result);
  evidence = await db.query(
    "SELECT count(*)::int AS count FROM vns.research_evidence WHERE job_id=$1 AND review_status='verified'",
    [jobId],
  );
  assert.equal(evidence.rows[0].count, 1);
  console.log("PASS: stalled retries do not create duplicate claims or replace reviewed evidence");

  // Same source/claim but changed publisher is not an idempotent replay.
  const conflict = createResearchProcessor(
    store,
    {
      async discover() {
        return [{ ...candidate, publisher: "Impostor Publisher" }];
      },
    },
    {
      async fetch() {
        return document;
      },
    },
  );
  await assert.rejects(conflict(queued), /conflicts with existing provenance/);
  console.log("PASS: conflicting replays fail closed without rewriting provenance");

  // Complete the *same* SQL outbox -> authenticated Redis -> dormant editorial
  // factory -> evidence -> SQL status flow, with no live adapters or VPS work.
  assert.equal((await reconcileJobStatusBatch(statusDb, queue, 10)).updated, 1);
  const completed = await db.query(
    "SELECT status, attempt_count, error_code FROM vns.jobs WHERE id=$1",
    [jobId],
  );
  assert.deepEqual(completed.rows[0], {
    status: "done",
    attempt_count: 1,
    error_code: null,
  });
  assert.equal((await reconcileJobStatusBatch(statusDb, queue, 10)).updated, 0);
  assert.equal((await dispatchOutboxBatch(dispatchDb, queue, 10)).newlyEnqueued, 0);
  console.log(
    "PASS: dormant editorial factory + outbox + PostgreSQL status complete synthetic job",
  );

  // Negative integrated scenario: deliberately invalid source discovery must
  // exhaust the bounded queue retry policy, retain a failed Redis job and
  // surface a sanitized PostgreSQL failure with no fabricated evidence.
  // Stop the successful synthetic worker first to avoid competing consumers.
  await worker.close();
  await workerConnection.quit().catch(() => undefined);
  worker = undefined;
  workerConnection = undefined;

  const failureTopic = "Synthetic research with unacceptable source candidates";
  const failedCreate = await db.query(
    "SELECT vns.create_research_request($1, $2) AS id",
    ["ci-research-invalid-source-001", failureTopic],
  );
  const failedId = failedCreate.rows[0].id;
  await dispatchOutboxBatch(dispatchDb, queue, 10);
  const failedQueueId = "job-" + failedId.replaceAll("-", "");
  const failedJob = await queue.getJob(failedQueueId);
  assert.ok(failedJob, "negative research job must be in the queue");
  assert.equal(failedJob.opts.attempts, 3);

  let rejectedDiscoveries = 0;
  let unexpectedFetches = 0;
  const failingHandler = createResearchProcessor(
    store,
    {
      async discover(topicToReject) {
        assert.equal(topicToReject, failureTopic);
        rejectedDiscoveries += 1;
        return []; // Never a source candidate, never an editorial verdict.
      },
    },
    {
      async fetch() {
        unexpectedFetches += 1;
        throw new Error("CI negative discovery must not reach fetch");
      },
    },
  );
  ({ worker, connection: workerConnection } = createDormantEditorialWorker(
    { host: connection.host, port: connection.port, password: connection.password },
    true,
    failingHandler,
  ));
  assert.equal(worker.opts.autorun, false);
  worker.on("error", () => console.error("CI negative editorial worker error"));
  const negativeRun = worker.run();
  negativeRun.catch(() => console.error("CI negative editorial worker stopped"));
  await worker.waitUntilReady();

  await assert.rejects(
    failedJob.waitUntilFinished(events, 25000),
    /Research source count outside approved bounds/,
  );
  assert.equal(await failedJob.getState(), "failed");
  const retainedFailure = await queue.getJob(failedQueueId);
  assert.ok(retainedFailure);
  assert.equal(retainedFailure.attemptsMade, 3);
  assert.equal(rejectedDiscoveries, 3);
  assert.equal(unexpectedFetches, 0);
  const evidenceAfterFailure = await db.query(
    "SELECT count(*)::int AS total FROM vns.research_evidence WHERE job_id = $1",
    [failedId],
  );
  assert.equal(evidenceAfterFailure.rows[0].total, 0);

  assert.equal((await reconcileJobStatusBatch(statusDb, queue, 10)).updated, 1);
  const failedLedger = await db.query(
    "SELECT status, attempt_count, error_code FROM vns.jobs WHERE id = $1",
    [failedId],
  );
  assert.deepEqual(failedLedger.rows[0], {
    status: "failed",
    attempt_count: 3,
    error_code: "bullmq_failed",
  });
  assert.equal((await reconcileJobStatusBatch(statusDb, queue, 10)).updated, 0);
  assert.equal((await dispatchOutboxBatch(dispatchDb, queue, 10)).newlyEnqueued, 0);
  assert.equal(retainedFailure.id, failedQueueId);
  assert.equal(await failedJob.getState(), "failed");
  console.log(
    "PASS: invalid synthetic research exhausts retries, retains failed job and sanitized SQL status",
  );
} finally {
  await Promise.allSettled(
    [
      worker?.close(),
      events.close(),
      queue.close(),
      db.end(),
      dispatchDb.end(),
      statusDb.end(),
      researchDb.end(),
    ].filter(Boolean),
  );
  await Promise.allSettled(
    [producerRedis, eventRedis, workerConnection].filter(Boolean).map((conn) => conn.quit()),
  );
}
