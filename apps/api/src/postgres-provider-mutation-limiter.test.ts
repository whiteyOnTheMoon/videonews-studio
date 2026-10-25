import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresProviderMutationLimiter } from "./postgres-provider-mutation-limiter.js";

test("database gate uses only the restricted, parameter-free function", async () => {
  const calls: string[] = [];
  const pool = {
    async query(sql: string) {
      calls.push(sql);
      return { rows: [{ allowed: true }] };
    },
  } as unknown as Pool;
  const limiter = new PostgresProviderMutationLimiter(pool);
  assert.equal(await limiter.allow(), true);
  assert.deepEqual(calls, ["SELECT vns.admin_try_ai_provider_mutation_slot() AS allowed"]);
  assert.ok(!calls[0]?.includes("ai_provider_sealed_credentials"));
});

test("shared fixture state applies across two independent limiter objects", async () => {
  let attempts = 0;
  const pool = {
    async query() {
      attempts++;
      return { rows: [{ allowed: attempts <= 5 }] };
    },
  } as unknown as Pool;
  const first = new PostgresProviderMutationLimiter(pool);
  const second = new PostgresProviderMutationLimiter(pool);
  for (let index = 0; index < 5; index++) {
    assert.equal(await (index % 2 === 0 ? first : second).allow(), true);
  }
  assert.equal(await second.allow(), false);
  assert.equal(attempts, 6);
});

test("database outages and malformed replies fail closed without diagnostics", async () => {
  const broken = {
    async query() {
      throw new Error("postgres://ci-private-secret@host.invalid");
    },
  } as unknown as Pool;
  await assert.rejects(
    new PostgresProviderMutationLimiter(broken).allow(),
    (error: Error) => error.message === "Provider mutation admission unavailable",
  );
  const invalidRows: unknown[][] = [
    [],
    [{ allowed: "t" }],
    [{ allowed: true }, { allowed: false }],
  ];
  for (const rows of invalidRows) {
    const pool = {
      async query() {
        return { rows };
      },
    } as unknown as Pool;
    await assert.rejects(
      new PostgresProviderMutationLimiter(pool).allow(),
      /Provider mutation admission unavailable/,
    );
  }
});
