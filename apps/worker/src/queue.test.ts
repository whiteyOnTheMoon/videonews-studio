import assert from "node:assert/strict";
import test from "node:test";
import { processProbeJob, readQueueConfig } from "./queue.js";
import type { Job } from "bullmq";

const dummy = (name: string, data: unknown) => ({ name, data }) as Job;

test("disabled worker fails closed", () => {
  assert.throws(() => readQueueConfig({}), /explicitly enabled/);
});

test("worker requires fixed Docker secret path", () => {
  assert.throws(
    () => readQueueConfig({ VNS_WORKER_ENABLED: "true", VNS_REDIS_PASSWORD_FILE: "/tmp/pw" }),
    /Docker secret/,
  );
});

test("accepts constrained Redis host and port with injected secret reader", () => {
  const config = readQueueConfig(
    {
      VNS_WORKER_ENABLED: "true",
      VNS_REDIS_PASSWORD_FILE: "/run/secrets/redis_password",
      VNS_REDIS_HOST: "redis",
      VNS_REDIS_PORT: "6379",
    },
    () => "a".repeat(60) + "\n",
  );
  assert.equal(config.host, "redis");
  assert.equal(config.password, "a".repeat(60));
  assert.equal(config.port, 6379);
});

test("rejects arbitrary host and invalid secret", () => {
  assert.throws(
    () =>
      readQueueConfig(
        {
          VNS_WORKER_ENABLED: "true",
          VNS_REDIS_PASSWORD_FILE: "/run/secrets/redis_password",
          VNS_REDIS_HOST: "example.com",
        },
        () => "a".repeat(60),
      ),
    /configuration invalid/,
  );
  assert.throws(
    () =>
      readQueueConfig(
        {
          VNS_WORKER_ENABLED: "true",
          VNS_REDIS_PASSWORD_FILE: "/run/secrets/redis_password",
        },
        () => "123",
      ),
    /secret invalid/,
  );
});

test("probe has no side effects; other tasks are rejected", async () => {
  assert.deepEqual(await processProbeJob(dummy("probe", { kind: "probe" })), { ok: true });
  await assert.rejects(processProbeJob(dummy("render", { kind: "render" })), /Unsupported/);
  await assert.rejects(
    processProbeJob(dummy("probe", { kind: "probe", unsafe: true })),
    /Unsupported/,
  );
});
