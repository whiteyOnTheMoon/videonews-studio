import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { readFeedRuntimeAdmission, attestFeedDatabaseIdentity } from "./feed-runtime-admission.js";

const login = "vns_feed_login_observer";
const env: NodeJS.ProcessEnv = {
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_SIGNED_EXPORT_ENABLED: "true",
  VNS_FEED_SOURCE_ANCHOR_APPROVED: "true",
  VNS_FEED_TRUST_POLICY_APPROVED: "true",
  VNS_FEED_TRUST_POLICY_REVISION: "1",
  VNS_FEED_SIGNED_SOURCE_INBOX: "/var/lib/vns/feed-source-inbox",
  VNS_FEED_SOURCE_CHECKPOINT_DIR: "/var/lib/vns/feed-source-checkpoint",
  VNS_FEED_SOURCE_PUBLIC_KEY_FILE: "/run/secrets/vns_feed_source_public_key",
  VNS_FEED_SOURCE_ANCHOR_PASSWORD_FILE: "/run/secrets/vns_feed_source_anchor_password",
  VNS_FEED_SOURCE_ANCHOR_CA_FILE: "/run/secrets/vns_feed_source_anchor_ca",
  VNS_FEED_SOURCE_ANCHOR_HOST: "source-anchor.example.org",
  VNS_FEED_SOURCE_ANCHOR_USER: "vns_anchor_login_worker",
  VNS_FEED_SOURCE_BOOTSTRAP: "false",
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
  assert.equal(admission.trustPolicyRevision, 1);
  assert.equal(admission.dbHost, "postgres");
  assert.equal(admission.anchorPlacement, "separate_tls");
  assert.equal(admission.anchorDatabase, "vns_source_anchor");
  for (const flag of [
    "VNS_FEED_RUNTIME_ENABLED",
    "VNS_FEED_SIGNED_EXPORT_ENABLED",
    "VNS_FEED_SOURCE_ANCHOR_APPROVED",
    "VNS_FEED_TRUST_POLICY_APPROVED",
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
    { VNS_FEED_SIGNED_SOURCE_INBOX: "/tmp/unsafe" },
    { VNS_FEED_SOURCE_CHECKPOINT_DIR: "/tmp/unsafe" },
    { VNS_FEED_SOURCE_PUBLIC_KEY_FILE: "/tmp/pubkey" },
    { VNS_FEED_SOURCE_ANCHOR_PASSWORD_FILE: "/tmp/key" },
    { VNS_FEED_SOURCE_ANCHOR_CA_FILE: "/tmp/ca" },
    { VNS_FEED_SOURCE_ANCHOR_HOST: "localhost" },
    { VNS_FEED_SOURCE_ANCHOR_HOST: "127.0.0.1" },
    { VNS_FEED_TRUST_POLICY_REVISION: "" },
    { VNS_FEED_TRUST_POLICY_REVISION: "0" },
    { VNS_FEED_TRUST_POLICY_REVISION: "-1" },
    { VNS_FEED_TRUST_POLICY_REVISION: "1.5" },
    { VNS_FEED_TRUST_POLICY_REVISION: "01" },
    { VNS_FEED_TRUST_POLICY_REVISION: "9007199254740992" },
    { VNS_FEED_SOURCE_ANCHOR_USER: "postgres" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "unknown" },
    { VNS_ALLOWED_SOURCE_HOSTS: "" },
  ]) {
    assert.throws(() => readFeedRuntimeAdmission({ ...env, ...change }));
  }
});

test("same-VPS anchor requires explicit shared-restore approval and exact Docker host", () => {
  const sameVps = {
    ...env,
    VNS_FEED_ANCHOR_PLACEMENT: "same_vps",
    VNS_FEED_SOURCE_ANCHOR_HOST: "postgres",
    VNS_FEED_SAME_VPS_RISK_ACK: "ACCEPT_SHARED_POSTGRES_AND_RESTORE_DOMAIN",
  };
  const admission = readFeedRuntimeAdmission(sameVps);
  assert.equal(admission.anchorPlacement, "same_vps");
  assert.equal(admission.anchorDatabase, "videonews");
  assert.equal(admission.anchorHost, "postgres");
  assert.equal(admission.initialBootstrap, false);
  for (const change of [
    { VNS_FEED_SAME_VPS_RISK_ACK: "" },
    { VNS_FEED_SAME_VPS_RISK_ACK: "true" },
    { VNS_FEED_SOURCE_ANCHOR_HOST: "127.0.0.1" },
    { VNS_FEED_SOURCE_ANCHOR_HOST: "source-anchor.example.org" },
    { VNS_FEED_SOURCE_ANCHOR_HOST: "redis" },
    { VNS_FEED_ANCHOR_PLACEMENT: "separate_tls" },
    { VNS_FEED_ANCHOR_PLACEMENT: "local" },
    { VNS_FEED_ANCHOR_PLACEMENT: "" },
  ]) {
    assert.throws(() => readFeedRuntimeAdmission({ ...sameVps, ...change }));
  }
  assert.throws(() =>
    readFeedRuntimeAdmission({
      ...env,
      VNS_FEED_SAME_VPS_RISK_ACK: "ACCEPT_SHARED_POSTGRES_AND_RESTORE_DOMAIN",
    }),
  );
  assert.throws(() => readFeedRuntimeAdmission({ ...env, VNS_FEED_ANCHOR_PLACEMENT: "same_vps" }));
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

test("signed worker bootstrap requires a separate explicit operator acknowledgement", () => {
  const approved = readFeedRuntimeAdmission({
    ...env,
    VNS_FEED_SOURCE_BOOTSTRAP: "true",
    VNS_FEED_SOURCE_BOOTSTRAP_OPERATOR_ACK: "true",
  });
  assert.equal(approved.initialBootstrap, true);
  assert.equal(approved.anchorHost, "source-anchor.example.org");
  assert.equal(approved.anchorUser, "vns_anchor_login_worker");
  assert.equal(approved.signedExportDirectory, "/var/lib/vns/feed-source-inbox");
  assert.equal(approved.signedCheckpointDirectory, "/var/lib/vns/feed-source-checkpoint");
  assert.equal(readFeedRuntimeAdmission(env).initialBootstrap, false);
});

test("signed one-shot NOAA canary gating happens inside runtime admission", () => {
  const selected = {
    ...env,
    VNS_FEED_CANARY_SOURCE_ID: "noaa_news",
    VNS_FEED_CANARY_OPERATOR_ACK: "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
  };
  const checked = readFeedRuntimeAdmission(selected);
  assert.equal(checked.initialBootstrap, false);
  assert.equal(checked.dbUser, login);
  for (const change of [
    { VNS_FEED_CANARY_SOURCE_ID: "nasa_news" },
    { VNS_FEED_CANARY_OPERATOR_ACK: "" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true", VNS_FEED_SOURCE_BOOTSTRAP_OPERATOR_ACK: "true" },
  ]) {
    assert.throws(
      () => readFeedRuntimeAdmission({ ...selected, ...change }),
      /canary gate refused/,
    );
  }
  assert.throws(
    () => readFeedRuntimeAdmission(selected, "persistent_worker"),
    /canary gate refused/,
  );
});

test("NASA-only single pass requires dedicated acknowledgement before secrets or connections", () => {
  const selected = {
    ...env,
    VNS_FEED_CANARY_SOURCE_ID: "nasa_news",
    VNS_FEED_CANARY_OPERATOR_ACK: "NASA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
  };
  const checked = readFeedRuntimeAdmission(selected);
  assert.equal(checked.initialBootstrap, false);
  assert.equal(checked.dbUser, login);
  for (const patch of [
    { VNS_FEED_CANARY_SOURCE_ID: "noaa_news" },
    { VNS_FEED_CANARY_SOURCE_ID: "usgs_news" },
    { VNS_FEED_CANARY_OPERATOR_ACK: "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" },
    { VNS_FEED_CANARY_OPERATOR_ACK: "USGS_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" },
    { VNS_FEED_CANARY_OPERATOR_ACK: "" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true", VNS_FEED_SOURCE_BOOTSTRAP_OPERATOR_ACK: "true" },
  ]) {
    assert.throws(() => readFeedRuntimeAdmission({ ...selected, ...patch }), /canary gate refused/);
  }
  assert.throws(
    () => readFeedRuntimeAdmission(selected, "persistent_worker"),
    /canary gate refused/,
  );
  assert.throws(
    () => readFeedRuntimeAdmission(selected, "bounded_producer"),
    /canary gate refused/,
  );
});
