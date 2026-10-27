import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { readFeedRuntimeAdmission, attestFeedDatabaseIdentity } from "./feed-runtime-admission.js";

const login = "vns_feed_login_observer";
const env: NodeJS.ProcessEnv = {
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_RUNTIME_OPERATOR_ACK: "true",
  VNS_FEED_RIGHTS_ATTESTED: "true",
  VNS_FEED_NETWORK_APPROVED: "true",
  VNS_FEED_RUNTIME_MODE: "single_pass",
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
  VNS_FEED_QUEUE_OPERATOR_ACK: "true",
  VNS_FEED_BULLMQ_BRIDGE_ENABLED: "true",
  VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_NAME: "vns-feed-poll",
  VNS_FEED_REGISTRY_FILE: "/run/secrets/reviewed_research_sources.json",
  VNS_FEED_DB_PASSWORD_FILE: "/run/secrets/vns_feed_db_password",
  VNS_FEED_REDIS_PASSWORD_FILE: "/run/secrets/vns_feed_redis_password",
  VNS_FEED_DB_HOST: "postgres",
  VNS_FEED_REDIS_HOST: "redis",
  VNS_FEED_DB_USER: login,
  VNS_FEED_REDIS_USER: "vns_feed_observer",
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: "news.example.org",
};

test("every independent operator gate is required before opening any connections", () => {
  const admission = readFeedRuntimeAdmission(env);
  assert.equal(admission.dbUser, login);
  assert.equal(admission.dbHost, "postgres");
  for (const flag of [
    "VNS_FEED_RUNTIME_ENABLED",
    "VNS_FEED_RUNTIME_OPERATOR_ACK",
    "VNS_FEED_RIGHTS_ATTESTED",
    "VNS_FEED_NETWORK_APPROVED",
    "VNS_FEED_OFFLINE_COMPOSITION_ENABLED",
    "VNS_FEED_OFFLINE_OPERATOR_ACK",
    "VNS_FEED_QUEUE_CONTRACT_ENABLED",
    "VNS_FEED_QUEUE_OPERATOR_ACK",
    "VNS_FEED_BULLMQ_BRIDGE_ENABLED",
    "VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK",
  ]) {
    assert.throws(
      () => readFeedRuntimeAdmission({ ...env, [flag]: undefined }),
      /not authorized/,
      flag,
    );
  }
  assert.throws(() => readFeedRuntimeAdmission({}), /not authorized/);
});

test("refuses automatic scheduling, arbitrary endpoints and shared database users", () => {
  for (const change of [
    { VNS_FEED_RUNTIME_MODE: "cron" },
    { VNS_FEED_RUNTIME_MODE: "repeat" },
    { VNS_FEED_QUEUE_NAME: "vns-jobs" },
    { VNS_FEED_DB_USER: "postgres" },
    { VNS_FEED_DB_USER: "vns_feed_poll_writer" },
    { VNS_FEED_DB_HOST: "public.example.org" },
    { VNS_FEED_REDIS_HOST: "public.example.org" },
    { VNS_FEED_REDIS_USER: "default" },
    { VNS_FEED_DB_PASSWORD_FILE: "/tmp/unsafe" },
    { VNS_FEED_REDIS_PASSWORD_FILE: "/tmp/unsafe" },
    { VNS_FEED_REGISTRY_FILE: "/tmp/unsafe" },
    { VNS_ALLOWED_SOURCE_HOSTS: "" },
  ]) {
    assert.throws(() => readFeedRuntimeAdmission({ ...env, ...change }));
  }
});

const allowed = {
  session_user: login,
  feed_writer: true,
  can_claim: false,
  can_commit: false,
  can_guarded_claim: true,
  can_guarded_commit: true,
  can_project: false,
  can_read_candidates: false,
  can_edit_accounts: false,
  superuser: false,
  create_role: false,
  create_db: false,
  replication: false,
  bypass_rls: false,
};

function db(row: unknown): Pick<Pool, "query"> {
  return {
    async query(sql: string) {
      assert.match(sql, /session_user/);
      return { rows: row === null ? [] : [row] };
    },
  } as unknown as Pick<Pool, "query">;
}

test("requires the actual PostgreSQL session identity and narrow function privileges", async () => {
  await attestFeedDatabaseIdentity(db(allowed), login);
  for (const field of [
    "feed_writer",
    "can_claim",
    "can_commit",
    "can_guarded_claim",
    "can_guarded_commit",
    "can_project",
    "can_read_candidates",
    "can_edit_accounts",
    "superuser",
    "create_role",
    "create_db",
    "replication",
    "bypass_rls",
  ]) {
    const corrupt = {
      ...allowed,
      [field]: ["feed_writer", "can_guarded_claim", "can_guarded_commit"].includes(field)
        ? false
        : true,
    };
    await assert.rejects(attestFeedDatabaseIdentity(db(corrupt), login), /admission denied/, field);
  }
  await assert.rejects(
    attestFeedDatabaseIdentity(db({ ...allowed, session_user: "vns_feed_login_other" }), login),
    /admission denied/,
  );
  await assert.rejects(attestFeedDatabaseIdentity(db(null), login), /admission denied/);
  await assert.rejects(attestFeedDatabaseIdentity(db(allowed), "postgres"), /identity refused/);
});
