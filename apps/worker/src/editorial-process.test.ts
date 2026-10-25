import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "bullmq";
import { createEditorialProcessor } from "./editorial-process.js";

const jobId = "12345678-1234-4234-8234-123456789abc";
const good = {
  name: "research",
  id: "job-" + jobId.replaceAll("-", ""),
  data: { kind: "research", jobId },
} as Job;

test("reject unsupported and malformed work without invoking handler", async () => {
  let invocations = 0;
  const process = createEditorialProcessor(async () => {
    invocations += 1;
    return { candidatesRecorded: 1, needsEditorialReview: true };
  });
  for (const candidate of [
    { ...good, name: "render" },
    { ...good, name: "upload" },
    { ...good, name: "script" },
    { ...good, name: "probe" },
    { ...good, data: { kind: "render", jobId } },
    { ...good, data: { ...good.data, unexpected: true } },
    { ...good, id: "job-wrong" },
    { ...good, data: { kind: "research", jobId: "not-a-uuid" } },
    { ...good, data: null },
  ]) {
    await assert.rejects(process(candidate as Job), /Unsupported editorial job envelope/);
  }
  assert.equal(invocations, 0);
});

test("does not accept research without an injected handler", async () => {
  await assert.rejects(createEditorialProcessor(undefined)(good), /not configured/);
});

test("valid synthetic research may return only bounded unverified evidence", async () => {
  const process = createEditorialProcessor(async (job) => {
    assert.equal(job.id, good.id);
    return { candidatesRecorded: 2, needsEditorialReview: true };
  });
  assert.deepEqual(await process(good), {
    candidatesRecorded: 2,
    needsEditorialReview: true,
  });
});

test("reject invalid results rather than treating work as approved", async () => {
  for (const invalid of [
    { candidatesRecorded: 0, needsEditorialReview: true },
    { candidatesRecorded: 4, needsEditorialReview: true },
    { candidatesRecorded: 1, needsEditorialReview: false },
  ]) {
    const process = createEditorialProcessor(async () => invalid as never);
    await assert.rejects(process(good), /invalid result/);
  }
});
