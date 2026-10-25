import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";
import type { EditorIdentity } from "./editor-auth.js";
import { sealProviderApiKey } from "./provider-credential-crypto.js";
import { PostgresNamedProviderConfigStore } from "./postgres-named-provider-config-store.js";

const ADMIN: EditorIdentity = {
  id: "fafa1111-1111-4111-8111-111111111111",
  username: "ci_named_admin",
  role: "admin",
  authVersion: 4,
};
const KEY = "sk-ci-synthetic-never-real-provider-secret-012345";

test("named SQL sends only sealed credentials and the verified identity", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as Pool;
  const store = new PostgresNamedProviderConfigStore(pool);
  const key = randomBytes(32);
  const sealed = sealProviderApiKey("openai", KEY, key);
  await store.mutateAsNamedAdmin(
    { provider: "openai", action: "set_key", sealedKey: sealed },
    ADMIN,
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /admin_mutate_ai_provider_as_editor/);
  assert.deepEqual(calls[0]?.params.slice(0, 3), ["openai", "set_key", null]);
  assert.equal(calls[0]?.params[6], ADMIN.id);
  assert.equal(calls[0]?.params[7], ADMIN.authVersion);
  assert.ok(Buffer.isBuffer(calls[0]?.params[3]));
  assert.ok(Buffer.isBuffer(calls[0]?.params[4]));
  assert.ok(Buffer.isBuffer(calls[0]?.params[5]));
  assert.ok(!JSON.stringify(calls).includes(KEY));
  key.fill(0);
});

test("named store refuses invalid identity and provider mutations before SQL", async () => {
  let calls = 0;
  const pool = {
    async query() {
      calls++;
      return { rows: [] };
    },
  } as unknown as Pool;
  const store = new PostgresNamedProviderConfigStore(pool);
  const change = { provider: "openai", action: "remove_key" } as const;
  for (const bad of [
    { ...ADMIN, role: "reviewer" },
    { ...ADMIN, role: "editor" },
    { ...ADMIN, id: "not-a-uuid" },
    { ...ADMIN, username: "person with spaces" },
    { ...ADMIN, authVersion: -1 },
    { ...ADMIN, authVersion: 2147483648 },
    null,
  ]) {
    await assert.rejects(
      store.mutateAsNamedAdmin(change, bad as EditorIdentity),
      /Invalid named provider administrator/,
    );
  }
  await assert.rejects(
    store.mutateAsNamedAdmin(
      { provider: "openai", action: "set_model", selectedModel: "gemini-3.8-flash-tts" },
      ADMIN,
    ),
    /Invalid provider mutation/,
  );
  assert.equal(calls, 0);
});

test("named audit SQL failure is sanitized", async () => {
  const pool = {
    async query() {
      throw new Error("postgres://secret-ci-host.invalid/db");
    },
  } as unknown as Pool;
  const store = new PostgresNamedProviderConfigStore(pool);
  await assert.rejects(
    store.mutateAsNamedAdmin({ provider: "openai", action: "remove_key" }, ADMIN),
    (error: Error) => error.message === "Named provider change unavailable",
  );
});
