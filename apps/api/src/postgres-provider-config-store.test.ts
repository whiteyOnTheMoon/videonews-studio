import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresProviderConfigStore } from "./postgres-provider-config-store.js";
import { sealProviderApiKey } from "./provider-credential-crypto.js";

const KEY = "sk-ci-fixture-never-live-secret-123456789";
const MASTER = randomBytes(32);

test("read-only metadata is queried via gated function, not provider tables", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      return {
        rows: [
          { provider: "google_gemini", selectedModel: "gemini-3.8-flash-tts", configured: false },
          { provider: "openai", selectedModel: "gpt-6.1-sol", configured: false },
        ],
      };
    },
  } as unknown as Pool;
  const store = new PostgresProviderConfigStore(pool);
  assert.equal((await store.list()).length, 2);
  assert.equal(queries.length, 1);
  assert.match(queries[0]?.sql ?? "", /vns\.admin_list_ai_providers/);
  assert.ok(!queries[0]?.sql.includes("ai_provider_sealed_credentials"));
});

test("key rotation sends only binary authenticated envelope via parameterized atomic DB function", async () => {
  const commands: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      commands.push({ sql, params });
      return { rows: [{ admin_mutate_ai_provider: null }] };
    },
  } as unknown as Pool;
  const store = new PostgresProviderConfigStore(pool);
  const first = sealProviderApiKey("openai", KEY, MASTER);
  const second = sealProviderApiKey("openai", KEY, MASTER);
  await store.mutateWithAudit({ action: "set_key", provider: "openai", sealedKey: first });
  await store.mutateWithAudit({ action: "set_key", provider: "openai", sealedKey: second });
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.match(command.sql, /admin_mutate_ai_provider/);
    assert.match(command.sql, /\$6::bytea/);
    assert.ok(!command.sql.includes(KEY));
    assert.equal(command.params[0], "openai");
    assert.equal(command.params[1], "set_key");
    assert.equal(command.params[2], null);
    assert.ok(Buffer.isBuffer(command.params[3]));
    assert.ok(Buffer.isBuffer(command.params[4]));
    assert.ok(Buffer.isBuffer(command.params[5]));
    assert.equal((command.params[3] as Buffer).length, 12);
    assert.equal((command.params[5] as Buffer).length, 16);
    assert.ok(!JSON.stringify(command.params).includes(KEY));
  }
  assert.notDeepEqual(commands[0]?.params[3], commands[1]?.params[3]);
});

test("model and key removal use typed nulls and never expose keys", async () => {
  const calls: unknown[][] = [];
  const pool = {
    async query(_sql: string, values: unknown[]) {
      calls.push(values);
      return { rows: [] };
    },
  } as unknown as Pool;
  const store = new PostgresProviderConfigStore(pool);
  await store.mutateWithAudit({
    provider: "openai",
    action: "set_model",
    selectedModel: "gpt-6-luna",
  });
  await store.mutateWithAudit({ provider: "google_gemini", action: "remove_key" });
  assert.deepEqual(calls, [
    ["openai", "set_model", "gpt-6-luna", null, null, null],
    ["google_gemini", "remove_key", null, null, null, null],
  ]);
});

test("unrecognized provider, model and corrupted envelope never reach SQL", async () => {
  let calls = 0;
  const pool = {
    async query() {
      calls++;
      return { rows: [] };
    },
  } as unknown as Pool;
  const store = new PostgresProviderConfigStore(pool);
  const sealed = sealProviderApiKey("openai", KEY, MASTER);
  const malformed = [
    { provider: "new_provider", action: "remove_key" },
    { provider: "openai", action: "enable" },
    { provider: "openai", action: "set_key", sealedKey: { ...sealed, nonce: "bad!" } },
    { provider: "openai", action: "set_key", sealedKey: { ...sealed, tag: "bad!" } },
    { provider: "openai", action: "set_key", sealedKey: { ...sealed, ciphertext: "" } },
    { provider: "openai", action: "set_key", sealedKey: { ...sealed, version: 2 } },
    { provider: "openai", action: "set_key", sealedKey: sealed, selectedModel: "gpt-6-luna" },
    { provider: "google_gemini", action: "set_model", selectedModel: "gpt-6-luna" },
    { provider: "openai", action: "set_model", selectedModel: "gpt-6.1-sol", sealedKey: sealed },
    { provider: "openai", action: "remove_key", selectedModel: "gpt-6-luna" },
  ];
  for (const bad of malformed) {
    await assert.rejects(store.mutateWithAudit(bad as never), /Invalid/);
  }
  assert.equal(calls, 0);
});

test("failed SQL calls never expose database connection details or ciphertext", async () => {
  const pool = {
    async query() {
      throw new Error("private DB host postgres://secret-ci-credential");
    },
  } as unknown as Pool;
  const store = new PostgresProviderConfigStore(pool);
  await assert.rejects(
    store.mutateWithAudit({ provider: "openai", action: "remove_key" }),
    (error: Error) => error.message === "Provider change unavailable",
  );
  await assert.rejects(
    store.list(),
    (error: Error) => error.message === "Provider metadata unavailable",
  );
});
