import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  PROVIDER_WORKER_DB_IDENTITIES,
} from "./provider-worker-db-admission.js";
import { dormantSeparatedProviderWorker } from "./provider-worker-offline-assembly.js";

const reservation = {
  jobId: "ab110001-0000-4000-8000-000000000001",
  requestId: "ci_provider_assembly_001",
  provider: "openai" as const,
  model: "synthetic-model",
  priceSnapshotId: "ab110002-0000-4000-8000-000000000002",
  maxInputTokens: 128,
  maxOutputTokens: 64,
};

function db(kind: "usage" | "secret", wrong = false) {
  const events: string[] = [];
  const conn = {
    async query(sql: string) {
      events.push("sql:" + kind);
      if (!sql.includes("pg_has_role(")) throw Error("Reservation attempted in admission test");
      return { rows: [{
        session_user: PROVIDER_WORKER_DB_IDENTITIES[kind],
        current_user: PROVIDER_WORKER_DB_IDENTITIES[kind],
        role_member: !wrong,
        other_role_member: wrong,
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
        read_only: false,
      }] };
    },
    async connect() { throw Error("No transaction should start"); },
  } as unknown as Pick<Pool, "query" | "connect">;
  return { conn, events };
}

test("composition is off by default; SQL and transport remain untouched", async () => {
  const usage = db("usage");
  const secret = db("secret");
  let network = 0, masterKey = 0;
  const transport = { async send() { network++; throw Error("unexpected"); } };
  const keyScope = async <T>() => { masterKey++; throw Error("unexpected"); return null as T; };
  await assert.rejects(
    dormantSeparatedProviderWorker(usage.conn, secret.conn, transport, keyScope),
    /composition disabled/,
  );
  assert.equal(network, 0);
  assert.equal(masterKey, 0);
  assert.deepEqual(usage.events, []);
  assert.deepEqual(secret.events, []);
});

test("separate identities are required before any worker reservation or provider call", async () => {
  const usage = db("usage");
  const secret = db("secret", true);
  let sent = 0;
  await assert.rejects(
    dormantSeparatedProviderWorker(
      usage.conn, secret.conn,
      { async send() { sent++; return {}; } },
      async () => { throw Error("secret access"); },
      true,
    ),
    /database admission denied/,
  );
  assert.deepEqual(usage.events, ["sql:usage"]);
  assert.deepEqual(secret.events, ["sql:secret"]);
  assert.equal(sent, 0);
  await assert.rejects(
    dormantSeparatedProviderWorker(
      usage.conn, usage.conn,
      { async send() { sent++; return {}; } },
      async () => { throw Error("secret access"); },
      true,
    ),
    /composition disabled/,
  );
  assert.equal(sent, 0);
});

test("successful attestation assembles components but does not book or dispatch", async () => {
  const usage = db("usage");
  const secret = db("secret");
  let sends = 0, reads = 0;
  const coordinator = await dormantSeparatedProviderWorker(
    usage.conn, secret.conn,
    { async send() { sends++; return {}; } },
    async () => { reads++; throw Error("no credential"); },
    true,
  );
  assert.deepEqual(usage.events, ["sql:usage"]);
  assert.deepEqual(secret.events, ["sql:secret"]);
  await assert.rejects(
    coordinator.run(reservation, ""),
    /Provider text request invalid/,
  );
  assert.deepEqual(usage.events, ["sql:usage"]);
  assert.deepEqual(secret.events, ["sql:secret"]);
  assert.equal(sends, 0);
  assert.equal(reads, 0);
});
