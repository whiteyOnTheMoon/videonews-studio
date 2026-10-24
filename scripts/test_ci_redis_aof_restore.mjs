// P1-07: synthetic Redis AOF fixture, restricted to GitHub Actions.
// Seed/verify ONLY. Never starts a BullMQ Worker, dispatcher or real side effects.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAME, QUEUE_PREFIX } from "../apps/worker/dist/queue.js";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CI !== "true" ||
  process.env.GITHUB_REPOSITORY !== "whiteyOnTheMoon/videonews-studio" ||
  process.env.VNS_CI_AOF_DRILL !== "true" ||
  !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
) {
  throw new Error("REFUSED: GitHub Actions disposable Redis AOF drill only");
}
const mode = process.argv[2];
if (mode !== "seed" && mode !== "verify") throw new Error("REFUSED: unknown AOF drill mode");
const secretPath = process.env.VNS_TEST_REDIS_PASSWORD_FILE;
if (!secretPath?.startsWith("/tmp/")) throw new Error("REFUSED: temporary Redis ACL only");
const config = {
  host: "127.0.0.1",
  port: 16380,
  username: "vns_worker",
  password: readFileSync(secretPath, "utf8").trimEnd(),
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
};
const connection = new Redis(config);
const queue = new Queue(QUEUE_NAME, { connection, prefix: QUEUE_PREFIX });
const examples = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "research",
    state: "waiting",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    kind: "script",
    state: "delayed",
  },
];
const queueJobId = (id) => "job-" + id.replaceAll("-", "");
try {
  await queue.waitUntilReady();
  if (mode === "seed") {
    for (const item of examples) {
      const job = await queue.add(
        item.kind,
        { kind: item.kind, jobId: item.id },
        {
          jobId: queueJobId(item.id),
          attempts: 3,
          delay: item.state === "delayed" ? 3600_000 : 0,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
      assert.equal(job.id, queueJobId(item.id));
    }
  }
  for (const item of examples) {
    const job = await queue.getJob(queueJobId(item.id));
    if (!job) {
      const counts = await queue.getJobCounts("waiting", "delayed", "completed", "failed");
      const persistence = await connection.info("persistence");
      const fields = persistence
        .split("\\n")
        .filter((line) =>
          /^(aof_enabled|aof_current_size|aof_last_write_status|loading):/.test(line),
        );
      console.log("CI-AOF-DIAG: counts", JSON.stringify(counts), "persistence", fields.join(" "));
    }
    assert.ok(job, "AOF test job missing");
    assert.equal(job.id, queueJobId(item.id));
    assert.equal(job.name, item.kind);
    assert.deepEqual(job.data, { kind: item.kind, jobId: item.id });
    assert.equal(await job.getState(), item.state);
    assert.equal(job.opts.attempts, 3);
    assert.equal(job.opts.removeOnComplete, false);
    assert.equal(job.opts.removeOnFail, false);
  }
  const counts = await queue.getJobCounts("waiting", "delayed", "completed", "failed", "active");
  assert.equal(counts.waiting, 1);
  assert.equal(counts.delayed, 1);
  assert.equal(counts.completed, 0);
  assert.equal(counts.failed, 0);
  assert.equal(counts.active, 0);
  const anyUnmatched = await queue.getJobs(["waiting", "delayed"], 0, 5, true);
  assert.equal(anyUnmatched.length, 2);
  console.log(`PASS: ${mode} authenticated Redis AOF preserves two synthetic jobs and states`);
  console.log("PASS: no worker, publishing, researcher or dispatcher started");
} finally {
  await queue.close();
  await connection.quit().catch(() => undefined);
}
