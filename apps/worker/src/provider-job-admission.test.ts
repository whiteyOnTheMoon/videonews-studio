import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "bullmq";
import { admitProviderQueueJob } from "./provider-job-admission.js";

const jobId = "a4310001-0000-4000-8000-000000000001";
const data = {
  request: {
    jobId,
    requestId: "provider_dispatch_00001",
    provider: "openai",
    model: "operator-reviewed-model",
    priceSnapshotId: "a4310002-0000-4000-8000-000000000002",
    maxInputTokens: 512,
    maxOutputTokens: 64,
  },
  prompt: "Verified editorial information.",
};
const job = (patch: Record<string, unknown> = {}) =>
  ({
    id: jobId,
    name: "provider-text",
    opts: { attempts: 1, jobId },
    data,
    ...patch,
  }) as unknown as Pick<Job, "id" | "name" | "data" | "opts">;

test("canonical single-attempt job is admitted without granting dispatch", () => {
  const admitted = admitProviderQueueJob(job());
  assert.deepEqual(admitted.request, data.request);
  assert.equal(admitted.prompt, data.prompt);
  assert.ok(Object.isFrozen(admitted));
  assert.ok(Object.isFrozen(admitted.request));
});

test("other queues, unknown fields and mismatched job identity fail closed", () => {
  for (const value of [
    job({ name: "probe" }),
    job({ id: "invalid" }),
    job({ data: { ...data, metadata: "untrusted" } }),
    job({
      data: {
        ...data,
        request: { ...data.request, jobId: "a4310003-0000-4000-8000-000000000003" },
      },
    }),
    job({ data: { ...data, request: { ...data.request, model: "https://invalid.example" } } }),
    job({ data: { ...data, request: { ...data.request, provider: "other" } } }),
    job({ data: { ...data, prompt: "" } }),
    job({ data: { ...data, prompt: "☃".repeat(11000) } }),
  ]) {
    assert.throws(() => admitProviderQueueJob(value), /admission denied/);
  }
});

test("BullMQ retry/repeat paths and missing explicit one-attempt contract fail closed", () => {
  for (const opts of [
    {},
    { attempts: 2, jobId },
    { attempts: 0, jobId },
    { attempts: 1, jobId: "other" },
    { attempts: 1 },
    { attempts: 1, jobId, repeat: { every: 1000 } },
  ]) {
    assert.throws(() => admitProviderQueueJob(job({ opts })), /admission denied/);
  }
});
