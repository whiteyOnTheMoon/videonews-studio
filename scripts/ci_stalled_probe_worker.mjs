// P1-07 GitHub Actions fixture: claim a probe and simulate a hard worker crash.
// Does not process real workload. Parent terminates the process with SIGKILL.
import { readFileSync } from "node:fs";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { QUEUE_NAME, QUEUE_PREFIX } from "../apps/worker/dist/queue.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("CI-only test fixture");
}

const passwordFile = process.env.VNS_TEST_REDIS_PASSWORD_FILE;
if (!passwordFile || !passwordFile.startsWith("/tmp/")) {
  throw new Error("CI-only Redis credential file required");
}
const password = readFileSync(passwordFile, "utf8").trim();
const connection = new Redis({
  host: "127.0.0.1",
  port: 16379,
  username: "vns_worker",
  password,
  maxRetriesPerRequest: null,
});
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name !== "probe" || job.data?.kind !== "probe") {
      throw new Error("Unsupported CI job");
    }
    process.stdout.write("CLAIMED\n");
    return new Promise(() => {}); // Parent forcibly kills this worker.
  },
  {
    connection,
    prefix: QUEUE_PREFIX,
    concurrency: 1,
    lockDuration: 3500,
    stalledInterval: 1000,
    maxStalledCount: 1,
  },
);
worker.on("error", () => process.stderr.write("CI worker error (details omitted)\n"));
await worker.waitUntilReady();
process.stdout.write("READY\n");
