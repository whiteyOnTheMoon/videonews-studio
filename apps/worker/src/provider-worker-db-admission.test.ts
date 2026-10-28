import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  PROVIDER_WORKER_DB_IDENTITIES,
  attestProviderWorkerDatabaseRole,
  attestSeparatedProviderWorkerDatabases,
} from "./provider-worker-db-admission.js";

function evidence(kind: "usage" | "secret", override: Record<string, unknown> = {}) {
  return {
    session_user: PROVIDER_WORKER_DB_IDENTITIES[kind],
    current_user: PROVIDER_WORKER_DB_IDENTITIES[kind],
    role_member: true,
    other_role_member: false,
    allowed_function: true,
    forbidden_function: false,
    direct_key_read: false,
    direct_key_write: false,
    policy_write: false,
    admin_change: false,
    superuser: false,
    create_role: false,
    create_db: false,
    replication: false,
    bypass_rls: false,
    read_only: true,
    ...override,
  };
}

function db(kind: "usage" | "secret", override: Record<string, unknown> = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const connection = {
    async query(sql: string, params: unknown[]) {
      queries.push({ sql, params });
      return { rows: [evidence(kind, override)] };
    },
  } as unknown as Pick<Pool, "query">;
  return { connection, queries };
}

test("budget and envelope readers have distinct, non-admin logins", () => {
  assert.equal(new Set(Object.values(PROVIDER_WORKER_DB_IDENTITIES)).size, 2);
  for (const value of Object.values(PROVIDER_WORKER_DB_IDENTITIES)) {
    assert.match(value, /^vns_provider_(?:usage|secret)_login$/);
    assert.notEqual(value, "vns");
  }
});

test("two independently admitted database principals are checked before composition", async () => {
  const usage = db("usage");
  const secret = db("secret");
  await attestSeparatedProviderWorkerDatabases(usage.connection, secret.connection);
  assert.equal(usage.queries.length, 1);
  assert.equal(secret.queries.length, 1);
  assert.deepEqual(usage.queries[0]!.params, [
    "vns_provider_usage_writer",
    "vns_provider_secret_reader",
    "vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)",
    "vns.claimed_provider_sealed_key(uuid,text)",
  ]);
  assert.deepEqual(secret.queries[0]!.params, [
    "vns_provider_secret_reader",
    "vns_provider_usage_writer",
    "vns.claimed_provider_sealed_key(uuid,text)",
    "vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)",
  ]);
  for (const query of [...usage.queries, ...secret.queries]) {
    assert.match(query.sql, /session_user/);
    assert.match(query.sql, /has_function_privilege/);
    assert.match(query.sql, /default_transaction_read_only/);
    assert.doesNotMatch(query.sql, /INSERT|UPDATE\s+vns|DELETE|claimed_provider_sealed_key\(\$1/i);
  }
});

test("same pool, wrong login and inherited opposite role are refused", async () => {
  const usage = db("usage");
  await assert.rejects(
    attestSeparatedProviderWorkerDatabases(usage.connection, usage.connection),
    /separation unavailable/,
  );
  assert.equal(usage.queries.length, 0);
  for (const bad of [
    { session_user: "vns" },
    { current_user: "vns_provider_usage_writer" },
    { other_role_member: true },
    { allowed_function: false },
    { forbidden_function: true },
    { direct_key_read: true },
    { direct_key_write: true },
    { policy_write: true },
    { admin_change: true },
    { superuser: true },
    { create_role: true },
    { create_db: true },
    { replication: true },
    { bypass_rls: true },
    { read_only: false },
  ]) {
    const unsafe = db("usage", bad);
    await assert.rejects(
      attestProviderWorkerDatabaseRole(
        unsafe.connection,
        "usage",
        PROVIDER_WORKER_DB_IDENTITIES.usage,
      ),
      /database admission denied/,
    );
  }
  await assert.rejects(
    attestProviderWorkerDatabaseRole(
      db("secret").connection,
      "secret",
      PROVIDER_WORKER_DB_IDENTITIES.usage,
    ),
    /identity unavailable/,
  );
});

test("database errors, absent or extra records never permit the second principal", async () => {
  let secretReads = 0;
  const failing = {
    async query() {
      throw new Error("private-postgresql-password");
    },
  } as unknown as Pick<Pool, "query">;
  const secret = {
    async query() {
      secretReads++;
      return { rows: [evidence("secret")] };
    },
  } as unknown as Pick<Pool, "query">;
  await assert.rejects(
    attestSeparatedProviderWorkerDatabases(failing, secret),
    (error: Error) => error.message === "Provider worker database admission denied",
  );
  assert.equal(secretReads, 0);
  for (const rows of [[], [evidence("usage"), evidence("usage")]]) {
    const invalid = {
      async query() {
        return { rows };
      },
    } as unknown as Pick<Pool, "query">;
    await assert.rejects(
      attestProviderWorkerDatabaseRole(invalid, "usage", PROVIDER_WORKER_DB_IDENTITIES.usage),
      /database admission denied/,
    );
  }
});

test("runtime assembly may attest write-capable sessions only when explicitly requested", async () => {
  const writer = db("usage", { read_only: false });
  await attestProviderWorkerDatabaseRole(
    writer.connection,
    "usage",
    PROVIDER_WORKER_DB_IDENTITIES.usage,
    false,
  );
  await assert.rejects(
    attestProviderWorkerDatabaseRole(
      writer.connection,
      "usage",
      PROVIDER_WORKER_DB_IDENTITIES.usage,
      true,
    ),
    /database admission denied/,
  );
});
