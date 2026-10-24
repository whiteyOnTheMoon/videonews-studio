// CI-only: synthetic BullMQ research worker -> real PostgreSQL evidence ledger.
// No external network fetching, provider credentials, research, AI calls or publication.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import {
  createResearchProcessor,
  PostgresResearchEvidenceStore,
} from "../apps/worker/dist/research-process.js";
import { dispatchOutboxBatch } from "../apps/worker/dist/outbox.js";
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
const workerRedis = new Redis({ ...connection, maxRetriesPerRequest: null });
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
let worker;
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
const store = new PostgresResearchEvidenceStore(db);
const processor = createResearchProcessor(
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
try {
  await events.waitUntilReady();
  await queue.waitUntilReady();
  // Fully disposable CI DB/Redis: isolate synthetic research from earlier test jobs.
  await queue.obliterate({ force: true });
  await db.query("DELETE FROM vns.research_evidence");
  await db.query("DELETE FROM vns.job_outbox");
  await db.query("DELETE FROM vns.research_requests");
  await db.query("DELETE FROM vns.jobs");
  const key = "ci-research-proc-job-001";
  const created = await db.query("SELECT vns.create_research_request($1, $2) AS id", [key, topic]);
  const jobId = created.rows[0].id;
  // The test runner might still have earlier CI job fixtures; only require
  // that our deterministic ID appears, not that the batch inserted one.
  for (let i = 0; i < 10; i++) {
    await dispatchOutboxBatch(db, queue, 10);
    if (await queue.getJob("job-" + jobId.replaceAll("-", ""))) break;
  }
  const queued = await queue.getJob("job-" + jobId.replaceAll("-", ""));
  assert.ok(queued);
  worker = new Worker(QUEUE_NAME, processor, {
    connection: workerRedis,
    prefix: QUEUE_PREFIX,
    concurrency: 1,
  });
  worker.on("error", () => console.error("CI worker error"));
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
} finally {
  await Promise.allSettled(
    [worker?.close(), events.close(), queue.close(), db.end()].filter(Boolean),
  );
  await Promise.allSettled([producerRedis, eventRedis, workerRedis].map((conn) => conn.quit()));
}
