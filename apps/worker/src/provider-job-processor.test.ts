import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "bullmq";
import type { dormantOneShotTextCoordinator } from "./provider-one-shot-text-coordinator.js";
import {
  createDormantProviderJobProcessor,
  createSqlNamedProviderJobVerifier,
} from "./provider-job-processor.js";

const jobId = "a4310001-0000-4000-8000-000000000001";
const request = {
  jobId,
  requestId: "provider_dispatch_00001",
  provider: "openai",
  model: "operator-reviewed-model",
  priceSnapshotId: "a4310002-0000-4000-8000-000000000002",
  maxInputTokens: 512,
  maxOutputTokens: 64,
};
function job(patch: Record<string, unknown> = {}): Job {
  return {
    id: jobId,
    name: "provider-text",
    opts: { attempts: 1, jobId },
    attemptsMade: 0,
    stalledCounter: 0,
    data: { request, prompt: "Verified facts." },
    ...patch,
  } as unknown as Job;
}

test("processor remains disabled unless deliberately composed", () => {
  assert.throws(
    () =>
      createDormantProviderJobProcessor(
        {
          run: async () => {
            throw Error("never");
          },
        },
        async () => true,
      ),
    /disabled/,
  );
});

test("first attempt reaches injected SQL coordinator exactly once", async () => {
  const calls: unknown[][] = [];
  const coordinator = {
    async run(...args: unknown[]) {
      calls.push(args);
      return { reservationId: jobId, costMicroUsd: "5", reconciled: true as const };
    },
  } as unknown as Pick<ReturnType<typeof dormantOneShotTextCoordinator>, "run">;
  const result = await createDormantProviderJobProcessor(coordinator, async () => true, true)(job());
  assert.equal(result.reconciled, true);
  assert.deepEqual(calls, [[request, "Verified facts."]]);
});

test("replayed, stalled and malformed messages are denied before coordinator", async () => {
  let calls = 0;
  const coordinator = {
    async run() {
      calls++;
      throw Error("not allowed");
    },
  } as unknown as Pick<ReturnType<typeof dormantOneShotTextCoordinator>, "run">;
  const process = createDormantProviderJobProcessor(coordinator, async () => true, true);
  for (const value of [
    job({ attemptsMade: 1 }),
    job({ attemptsMade: -1 }),
    job({ stalledCounter: 1 }),
    job({ stalledCounter: -1 }),
    job({ opts: { attempts: 2, jobId } }),
    job({ id: "mismatch" }),
    job({ data: { request, prompt: "Verified facts.", extra: "untrusted" } }),
  ]) {
    await assert.rejects(process(value), /Provider job (replay|admission) denied/);
  }
  assert.equal(calls, 0);
});

test("denied or unavailable SQL authority never reaches the coordinator", async () => {
  let invoked = 0;
  const coordinator = {
    async run() {
      invoked++;
      throw Error("unreachable");
    },
  };
  await assert.rejects(
    createDormantProviderJobProcessor(coordinator, async () => false, true)(job()),
    /authorization denied/,
  );
  await assert.rejects(
    createDormantProviderJobProcessor(
      coordinator,
      async () => {
        throw Error("sql down");
      },
      true,
    )(job()),
    /authorization unavailable/,
  );
  assert.equal(invoked, 0);
});

test("coordinator failures are never retried locally", async () => {
  let calls = 0;
  const coordinator = {
    async run() {
      calls++;
      throw Error("Provider budget review required");
    },
  } as unknown as Pick<ReturnType<typeof dormantOneShotTextCoordinator>, "run">;
  await assert.rejects(
    createDormantProviderJobProcessor(coordinator, async () => true, true)(job()),
    /budget review required/,
  );
  assert.equal(calls, 1);
});

test("SQL verifier binds all immutable request fields and prompt digest", async () => {
  const calls: unknown[][] = [];
  const db = {
    async query(sql: string, params: unknown[]) {
      assert.match(sql, /verify_provider_named_job_authorization/);
      calls.push(params);
      return { rows: [{ authorized: true }] };
    },
  };
  const verifier = createSqlNamedProviderJobVerifier(db as never);
  const verified = await verifier(request as never, "a".repeat(64));
  assert.equal(verified, true);
  assert.deepEqual(calls, [
    [
      request.jobId,
      request.requestId,
      request.provider,
      request.model,
      request.priceSnapshotId,
      "a".repeat(64),
      request.maxInputTokens,
      request.maxOutputTokens,
    ],
  ]);
});

test("SQL false, uncertain confirmation and database outage fail closed", async () => {
  for (const result of [
    [],
    [{ authorized: null }],
    [{ authorized: false }],
    [{ authorized: true }, { authorized: true }],
  ]) {
    const verify = createSqlNamedProviderJobVerifier({
      async query() {
        return { rows: result };
      },
    } as never);
    assert.equal(await verify(request as never, "a".repeat(64)), false);
  }
  const verify = createSqlNamedProviderJobVerifier({
    async query() {
      throw Error("sensitive connection details");
    },
  } as never);
  const unavailable = verify(request as never, "a".repeat(64));
  await assert.rejects(unavailable, /authorization unavailable/);
});
