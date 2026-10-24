// P1-07: read-only, bounded Redis inventory used before/after worker-only restart.
// Executed inside the already running trusted probe worker image. No mutations.
import { Queue } from "bullmq";
import Redis from "ioredis";
import { readFileSync } from "node:fs";

const password = readFileSync("/run/secrets/redis_password", "utf8").trim();
const redis = new Redis({
  host: "redis", port: 6379, username: "vns_worker", password,
  maxRetriesPerRequest: 1, connectTimeout: 3000, enableOfflineQueue: false,
});
const queue = new Queue("vns-jobs", { connection: redis, prefix: "bull:vns" });
let passed = false;
try {
  const expected = process.env.VNS_P107_EXPECTED_IDS?.split(",") ?? [];
  if (expected.length < 1 || expected.length > 2 ||
      expected.some((id) => !/^[-a-z0-9]{8,64}$/.test(id))) {
    throw new Error("unexpected probe receipt IDs");
  }
  const unsafe = [
    "waiting", "paused", "delayed", "active",
    "waiting-children", "prioritized", "failed",
  ];
  const counts = await queue.getJobCounts(...unsafe, "completed");
  if (unsafe.some((state) => counts[state] !== 0) ||
      counts.completed !== expected.length) {
    throw new Error("unprocessed or unexpected Redis jobs");
  }
  const entries = await queue.getJobs(["completed"], 0, expected.length - 1);
  const ids = new Set();
  if (entries.length !== expected.length) throw new Error("partial Redis inventory");
  for (const job of entries) {
    if (!expected.includes(job.id) || ids.has(job.id) ||
        job.name !== "probe" || job.data?.kind !== "probe" ||
        Object.keys(job.data ?? {}).length !== 1 ||
        job.returnvalue?.ok !== true || job.attemptsMade !== 1 ||
        await job.getState() !== "completed") {
      throw new Error("unexpected completed-job receipt");
    }
    ids.add(job.id);
  }
  console.log("PASS: queue idle; only expected completed probe receipts exist");
  passed = true;
} catch {
  console.error("REFUSED: queue inventory not safe for probe restart");
}
// A one-shot, read-only Redis client must not hang on a network connection.
process.exit(passed ? 0 : 1);
