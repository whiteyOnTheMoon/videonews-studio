// Disposable Redis/BullMQ reliability drill. CI only; never points at VPS Redis.
// BullMQ is at-least-once; these tests do NOT prove exactly-once side effects.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Queue, QueueEvents, Worker } from "bullmq";
import { Redis } from "ioredis";
import {
  createProbeWorker,
  processProbeJob,
  QUEUE_NAME,
  QUEUE_PREFIX,
} from "../apps/worker/dist/queue.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("Reliability drill is GitHub Actions only");
}
const passwordFile = process.env.VNS_TEST_REDIS_PASSWORD_FILE;
if (!passwordFile || !passwordFile.startsWith("/tmp/")) {
  throw new Error("CI-only Redis password file required");
}
const settings = {
  host: "127.0.0.1",
  port: 16379,
  username: "vns_worker",
  password: readFileSync(passwordFile, "utf8").trim(),
};
const connections = new Set();
const workers = new Set();
const createConnection = (options = {}) => {
  const connection = new Redis({ ...settings, maxRetriesPerRequest: null, ...options });
  connections.add(connection);
  return connection;
};
const queue = new Queue(QUEUE_NAME, {
  connection: createConnection({ maxRetriesPerRequest: 1 }),
  prefix: QUEUE_PREFIX,
});
const events = new QueueEvents(QUEUE_NAME, {
  connection: createConnection(),
  prefix: QUEUE_PREFIX,
});
events.on("error", () => console.error("CI QueueEvents error (details omitted)"));
let crashChild;

function waitForLine(child, lines, text, maxMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for CI worker state: " + text));
    }, maxMs);
    const onLine = (line) => {
      if (line === text) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error("CI worker exited before " + text));
    };
    function cleanup() {
      clearTimeout(timeout);
      lines.off("line", onLine);
      child.off("exit", onExit);
    }
    lines.on("line", onLine);
    child.on("exit", onExit);
  });
}

try {
  await events.waitUntilReady();
  await queue.waitUntilReady();

  // A second enqueue with the same retained jobId must not create a second job.
  const first = await queue.add("probe", { kind: "probe" }, {
    jobId: "ci-dedupe-probe",
    attempts: 1,
    removeOnComplete: false,
  });
  const duplicate = await queue.add("probe", { kind: "probe" }, {
    jobId: "ci-dedupe-probe",
    attempts: 1,
    removeOnComplete: false,
  });
  assert.equal(first.id, duplicate.id);
  assert.equal(await queue.getWaitingCount(), 1);
  const standard = createProbeWorker(settings);
  workers.add(standard.worker);
  connections.add(standard.connection);
  try {
    await standard.worker.waitUntilReady();
    assert.deepEqual(await first.waitUntilFinished(events, 15000), { ok: true });
    assert.equal(await first.getState(), "completed");
  } finally {
    await standard.worker.close();
    workers.delete(standard.worker);
  }
  assert.equal((await queue.getJobCounts("completed")).completed, 1);
  console.log("PASS: retained job ID rejects duplicate enqueue; probe completed once");

  // Transient failure is retried, then completed; no external effects.
  let calls = 0;
  const retryWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      assert.equal(job.name, "probe");
      assert.deepEqual(job.data, { kind: "probe" });
      calls += 1;
      if (calls === 1) throw new Error("ci-transient-only");
      return { ok: true };
    },
    { connection: createConnection(), prefix: QUEUE_PREFIX, concurrency: 1 },
  );
  workers.add(retryWorker);
  try {
    await retryWorker.waitUntilReady();
    const retryJob = await queue.add("probe", { kind: "probe" }, {
      jobId: "ci-retry-probe",
      attempts: 2,
      backoff: { type: "fixed", delay: 200 },
      removeOnComplete: false,
      removeOnFail: false,
    });
    assert.deepEqual(await retryJob.waitUntilFinished(events, 20000), { ok: true });
    assert.equal(calls, 2);
    assert.equal(await retryJob.getState(), "completed");
    console.log("PASS: transient probe failure retries exactly once");
  } finally {
    await retryWorker.close();
    workers.delete(retryWorker);
  }

  // Hard-kill a worker in mid-job. Redis stays up. A fresh worker should
  // reclaim an expired lock after BullMQ marks the job stalled.
  const fixture = fileURLToPath(new URL("./ci_stalled_probe_worker.mjs", import.meta.url));
  crashChild = spawn(process.execPath, [fixture], {
    env: {
      ...process.env,
      VNS_TEST_REDIS_PASSWORD_FILE: passwordFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  crashChild.stderr.on("data", () => {
    // Avoid leaking Redis internals or connection details.
  });
  const lines = createInterface({ input: crashChild.stdout });
  const ready = waitForLine(crashChild, lines, "READY");
  await ready;
  const claimed = waitForLine(crashChild, lines, "CLAIMED");
  const crashedJob = await queue.add("probe", { kind: "probe" }, {
    jobId: "ci-crash-probe",
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
  await claimed;
  const ended = once(crashChild, "exit");
  crashChild.kill("SIGKILL");
  await ended;
  crashChild = undefined;
  lines.close();

  const recoveryWorker = new Worker(QUEUE_NAME, processProbeJob, {
    connection: createConnection(),
    prefix: QUEUE_PREFIX,
    concurrency: 1,
    lockDuration: 3500,
    stalledInterval: 1000,
    maxStalledCount: 1,
  });
  workers.add(recoveryWorker);
  recoveryWorker.on("error", () => console.error("CI recovery worker error"));
  try {
    const done = crashedJob.waitUntilFinished(events, 45000);
    await recoveryWorker.waitUntilReady();
    assert.deepEqual(await done, { ok: true });
    assert.equal(await crashedJob.getState(), "completed");
    console.log("PASS: SIGKILL leaves a stalled probe; fresh worker reclaims it");
  } finally {
    await recoveryWorker.close();
    workers.delete(recoveryWorker);
  }
} finally {
  if (crashChild && !crashChild.killed) crashChild.kill("SIGKILL");
  for (const worker of workers) await worker.close().catch(() => undefined);
  await Promise.allSettled([events.close(), queue.close()]);
  await Promise.allSettled([...connections].map((connection) => connection.quit()));
}
