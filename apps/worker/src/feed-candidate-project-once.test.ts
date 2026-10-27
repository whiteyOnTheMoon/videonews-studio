import assert from "node:assert/strict";
import test from "node:test";
import {
  readProjectionAdmission,
  attestProjectionDatabaseIdentity,
  projectApprovedSource,
  type ProjectionIdentity,
} from "./feed-candidate-project-once.js";

const valid: NodeJS.ProcessEnv = {
  VNS_P2_FEED_PROJECTION_ENABLED: "true",
  VNS_P2_FEED_PROJECTION_OPERATOR_ACK: "true",
  VNS_P2_FEED_PROJECTION_MODE: "single_pass",
  VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP: "false",
  VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE: "/run/secrets/vns_feed_project_db_password",
  VNS_P2_FEED_PROJECTION_DB_HOST: "postgres",
  VNS_P2_FEED_PROJECTION_DB_USER: "vns_feed_project_login_ciunit",
  VNS_P2_FEED_PROJECTION_SOURCE_ID: "ci_news_source",
  VNS_P2_FEED_PROJECTION_LIMIT: "25",
};
const goodIdentity: ProjectionIdentity = {
  session_user: "vns_feed_project_login_ciunit",
  project_member: true,
  guarded_execute: true,
  raw_execute: false,
  direct_candidates: false,
  direct_claims: false,
  direct_events_write: false,
  feed_claim: false,
  edit_accounts: false,
  superuser: false,
  create_role: false,
  create_db: false,
  replication: false,
  bypass_rls: false,
};
function db(identity: ProjectionIdentity = goodIdentity, projected = 2) {
  const statements: string[] = [];
  const queries: readonly unknown[][] = [];
  return {
    statements,
    queries,
    async query(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes("pg_catalog.pg_roles")) return { rows: [identity] };
      if (sql.includes("project_approved_feed_candidates")) {
        assert.deepEqual(params, ["ci_news_source", 25]);
        return { rows: [{ projected }] };
      }
      throw Error("No unexpected SQL");
    },
  };
}

test("explicit one-shot mode, source id, separate login and bounds required before any secret", () => {
  assert.deepEqual(readProjectionAdmission(valid), {
    dbHost: "postgres",
    dbUser: "vns_feed_project_login_ciunit",
    sourceId: "ci_news_source",
    limit: 25,
  });
  for (const key of [
    "VNS_P2_FEED_PROJECTION_ENABLED",
    "VNS_P2_FEED_PROJECTION_OPERATOR_ACK",
  ]) assert.throws(() => readProjectionAdmission({ ...valid, [key]: "false" }));
  for (const [key, value] of [
    ["VNS_P2_FEED_PROJECTION_MODE", "continuous"],
    ["VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP", "true"],
    ["VNS_P2_FEED_PROJECTION_DB_HOST", "outside.example.org"],
    ["VNS_P2_FEED_PROJECTION_DB_USER", "postgres"],
    ["VNS_P2_FEED_PROJECTION_DB_USER", "vns_feed_login_shared"],
    ["VNS_P2_FEED_PROJECTION_SOURCE_ID", "other;drop"],
    ["VNS_P2_FEED_PROJECTION_LIMIT", "101"],
    ["VNS_P2_FEED_PROJECTION_LIMIT", "0"],
    ["VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE", "/tmp/secret"],
  ] as const) assert.throws(() => readProjectionAdmission({ ...valid, [key]: value }));
});

test("projector executes only current approved projection SQL with bound arguments", async () => {
  const pool = db();
  await attestProjectionDatabaseIdentity(pool as never, goodIdentity.session_user);
  assert.equal(await projectApprovedSource(pool as never, readProjectionAdmission(valid)), 2);
  assert.equal(pool.statements.filter((x) => x.startsWith("SELECT vns.project_approved_feed_candidates(")).length, 1);
  assert.equal(pool.statements.some((x) => x.startsWith("SELECT vns.project_feed_candidates(")), false);
});

test("stolen/overprivileged PostgreSQL identities fail before projection", async () => {
  const tampered: Partial<ProjectionIdentity>[] = [
    { session_user: "vns_feed_project_login_other" },
    { project_member: false },
    { guarded_execute: false },
    { raw_execute: true },
    { direct_candidates: true },
    { direct_claims: true },
    { direct_events_write: true },
    { feed_claim: true },
    { edit_accounts: true },
    { superuser: true },
    { create_role: true },
    { create_db: true },
    { replication: true },
    { bypass_rls: true },
  ];
  for (const change of tampered) {
    const pool = db({ ...goodIdentity, ...change });
    await assert.rejects(
      projectApprovedSource(pool as never, readProjectionAdmission(valid)),
      /database admission denied/,
    );
    assert.equal(pool.statements.some((x) => x.startsWith("SELECT vns.project_approved_feed_candidates(")), false);
  }
});

test("projection errors and impossible counts are redacted", async () => {
  const invalidCount = db(goodIdentity, 26);
  await assert.rejects(
    projectApprovedSource(invalidCount as never, readProjectionAdmission(valid)),
    /projection unavailable/,
  );
  const failing = {
    async query(sql: string) {
      if (sql.includes("pg_catalog.pg_roles")) return { rows: [goodIdentity] };
      throw Error("PRIVATE_DATABASE_HOST_PG_SECRET");
    },
  };
  await assert.rejects(
    projectApprovedSource(failing as never, readProjectionAdmission(valid)),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "P2 approved source projection unavailable",
  );
});
