// Disposable CI only: real PostgreSQL, SCRAM LOGIN, Redis ACL and BullMQ.
// No provider HTTP, no API secrets, no budget enablement and no live worker.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { sealProviderPrompt } from "../packages/shared/dist/index.js";
import { dormantProviderOutboxPublisher } from "../apps/worker/dist/provider-outbox-publisher.js";
import { PROVIDER_QUEUE } from "../apps/worker/dist/provider-dedicated-queue.js";
import { QUEUE_PREFIX } from "../apps/worker/dist/queue.js";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw Error("Not an isolated CI runner");
}
const key = randomBytes(32);
const secret = (name) => {
  const value = process.env[name];
  if (!value || !/^[0-9a-f]{64}$/.test(value)) throw Error("Missing CI-only credential");
  return value;
};
const dbConfig = {
  host: "127.0.0.1",
  port: 25432,
  database: "vns_provider_ci",
  max: 1,
  connectionTimeoutMillis: 3000,
};
const admin = new pg.Pool({
  ...dbConfig,
  user: "postgres",
  password: secret("VNS_E2E_PG_SUPER_PASSWORD"),
});
const sql = new pg.Pool({
  ...dbConfig,
  user: "vns_provider_outbox_login",
  password: secret("VNS_E2E_PG_PRODUCER_PASSWORD"),
});
const redis = new Redis({
  host: "127.0.0.1",
  port: 26379,
  username: "vns_provider_producer",
  password: secret("VNS_E2E_REDIS_PRODUCER_PASSWORD"),
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
  connectTimeout: 3000,
});
redis.on("error", () => undefined);
const queue = new Queue(PROVIDER_QUEUE, { prefix: QUEUE_PREFIX, connection: redis });
const scope = async (op) => op(key);
const producer = () => dormantProviderOutboxPublisher(sql, queue, scope, true);
const editor = "a4830001-0000-4000-8000-000000000001";
const model = "ci_real_outbox_model_48";
let priceId;

async function seedConfig() {
  // Disposable CI superuser is explicitly enrolled under the lifecycle
  // trigger before creating a synthetic personal admin. Never do on VPS.
  await admin.query(
    "INSERT INTO vns.editor_operator_registry(login_role,operator_id,operator_label,active) VALUES('postgres',$1::uuid,'CI isolated operator',true)",
    [randomUUID()],
  );
  await admin.query(
    `INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active,auth_version)
      VALUES($1,'ci_outbox_real_48','CI Real Outbox','admin',$2,true,0)`,
    [editor, "scrypt$" + "a".repeat(32) + "$" + "b".repeat(128)],
  );
  const connection = await admin.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL ROLE vns_provider_config_writer");
    await connection.query(
      `SELECT vns.admin_review_live_provider_price_as_editor(
       $1::uuid,0,'openai',$2,'ci_real_outbox_price_0048',
       1000000,100000,2000000,clock_timestamp()+interval '1 day',
       'https://example.invalid/ci-only-not-a-real-provider')`,
      [editor, model],
    );
    await connection.query(
      `SELECT vns.admin_mutate_ai_provider_as_editor(
        'openai','set_model',$1,NULL,NULL,NULL,$2::uuid,0)`,
      [model, editor],
    );
    await connection.query("COMMIT");
  } catch {
    await connection.query("ROLLBACK");
    throw Error("CI personal policy setup failed");
  } finally {
    connection.release();
  }
  const price = await admin.query(
    "SELECT id FROM vns.provider_live_price_snapshots WHERE provider='openai' AND model=$1",
    [model],
  );
  assert.equal(price.rows.length, 1);
  priceId = price.rows[0].id;
}

async function seedJob(label) {
  const prompt = "CI-only verified editorial evidence: " + label;
  const sealed = sealProviderPrompt(prompt, key);
  const requestId = "ci_real_outbox_request_" + label;
  const attempt = "ci_real_outbox_attempt_" + label + "_0048";
  const connection = await admin.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL ROLE vns_provider_config_writer");
    const result = await connection.query(
      `SELECT vns.admin_create_sealed_provider_job_as_editor(
        $1::uuid,0,$2,$3,'openai',$4,$5::uuid,
        $6,100,32,$7,$8,$9)::text AS job_id`,
      [
        editor,
        attempt,
        requestId,
        model,
        priceId,
        sealed.sha256,
        sealed.iv,
        sealed.tag,
        sealed.ciphertext,
      ],
    );
    assert.equal(result.rows.length, 1);
    await connection.query("COMMIT");
    return { id: result.rows[0].job_id, prompt };
  } catch {
    await connection.query("ROLLBACK");
    throw Error("CI personal SQL submission failed");
  } finally {
    connection.release();
  }
}

async function receiptCount(jobId) {
  const result = await admin.query(
    "SELECT count(*)::integer AS count FROM vns.provider_named_job_delivery_receipts WHERE job_id=$1::uuid",
    [jobId],
  );
  return result.rows[0].count;
}

async function main() {
  await queue.waitUntilReady();
  assert.equal(await redis.acl("WHOAMI"), "vns_provider_producer");
  await assert.rejects(
    redis.get("bull:vns:vns-jobs:meta"),
    /NOPERM/,
    "Redis producer must not access unrelated queue",
  );
  const ident = await sql.query(
    `SELECT session_user::text AS login,
      has_table_privilege(session_user,'vns.provider_named_job_sealed_prompts','SELECT') AS raw_read,
      has_function_privilege(session_user,'vns.read_authorized_provider_outbox(integer)','EXECUTE') AS scoped_read`,
  );
  assert.deepEqual(ident.rows, [
    {
      login: "vns_provider_outbox_login",
      raw_read: false,
      scoped_read: true,
    },
  ]);
  await assert.rejects(
    sql.query("SELECT ciphertext_base64 FROM vns.provider_named_job_sealed_prompts LIMIT 1"),
    (err) => err.code === "42501",
  );
  await seedConfig();

  // Real queue publication and durable SQL receipt.
  const first = await seedJob("normal");
  assert.deepEqual(await producer().runOnce(), { verified: 1, acknowledged: 1 });
  assert.equal(await receiptCount(first.id), 1);
  const persisted = await queue.getJob(first.id);
  assert.equal(persisted?.data.prompt, first.prompt);
  assert.equal(persisted?.opts.attempts, 1);
  assert.equal(persisted?.opts.removeOnComplete, false);
  assert.equal(persisted?.opts.removeOnFail, false);
  assert.deepEqual(await producer().runOnce(), { verified: 0, acknowledged: 0 });

  // Crash after Redis ACK but before committed SQL receipt.
  const replay = await seedJob("crash");
  let fail = true;
  const ambiguous = {
    query: async (statement, params) => {
      if (fail && statement.includes("ack_provider_outbox_delivery")) {
        fail = false;
        throw Error("synthetic PostgreSQL outage before receipt");
      }
      return sql.query(statement, params);
    },
  };
  await assert.rejects(
    dormantProviderOutboxPublisher(ambiguous, queue, scope, true).runOnce(),
    /unavailable/,
  );
  assert.equal(await receiptCount(replay.id), 0);
  assert.equal((await queue.getJob(replay.id))?.data.prompt, replay.prompt);
  assert.deepEqual(await producer().runOnce(), { verified: 1, acknowledged: 1 });
  assert.equal(await receiptCount(replay.id), 1);
  const idsAfterRecovery = (await queue.getJobs(["waiting", "paused", "delayed"])).filter(
    (j) => j.id === replay.id,
  );
  assert.equal(idsAfterRecovery.length, 1);

  // Forged/colliding Redis job must never be silently confirmed.
  const collision = await seedJob("collision");
  await queue.add(
    "provider-text",
    { request: { jobId: collision.id }, prompt: "untrusted" },
    { jobId: collision.id, attempts: 1, removeOnComplete: false, removeOnFail: false },
  );
  await assert.rejects(producer().runOnce(), /unavailable/);
  assert.equal(await receiptCount(collision.id), 0);
  assert.equal((await queue.getJob(collision.id))?.data.prompt, "untrusted");

  // A second SQL reader must not accidentally be able to amend receipts or
  // remove a published job through another queue namespace.
  await assert.rejects(
    sql.query("DELETE FROM vns.provider_named_job_delivery_receipts WHERE job_id=$1", [first.id]),
    (err) => err.code === "42501",
  );
  assert.equal(await receiptCount(first.id), 1);
  console.info(
    JSON.stringify({
      event: "isolated_provider_sql_redis_e2e",
      status: "pass",
      scenarios: [
        "personal SQL job",
        "SCRAM role",
        "Redis ACL",
        "publish",
        "crash-recovery",
        "collision",
        "receipt immutability",
      ],
    }),
  );
}
try {
  await main();
} finally {
  key.fill(0);
  await queue.close().catch(() => undefined);
  redis.disconnect();
  await sql.end().catch(() => undefined);
  await admin.end().catch(() => undefined);
}
