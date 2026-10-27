import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  attestProjectionDatabaseIdentity,
  projectApprovedSource,
  readProjectionAdmission,
} from "../apps/worker/dist/feed-candidate-project-once.js";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CI !== "true" ||
  process.env.VNS_P2_ISOLATED_PORT_TEST !== "true"
) throw new Error("P2 projection integration is disposable CI only");

test("isolated real PostgreSQL: enrolled projection login has only guarded rights", async () => {
  const env = {
    VNS_P2_FEED_PROJECTION_ENABLED: "true",
    VNS_P2_FEED_PROJECTION_OPERATOR_ACK: "true",
    VNS_P2_FEED_PROJECTION_MODE: "single_pass",
    VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP: "false",
    VNS_P2_FEED_PROJECTION_DB_HOST: "127.0.0.1",
    VNS_P2_FEED_PROJECTION_DB_USER: "vns_feed_project_login_ciunit",
    VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE: "/run/secrets/vns_feed_project_db_password",
    VNS_P2_FEED_PROJECTION_SOURCE_ID: "ci_projection_missing",
    VNS_P2_FEED_PROJECTION_LIMIT: "5",
  };
  const pool = new Pool({
    host: "127.0.0.1",
    port: 5432,
    database: "vns_p2_ci",
    user: "vns_feed_project_login_ciunit",
    password: process.env.VNS_P2_CI_PROJECT_PASSWORD,
    max: 1,
  });
  try {
    await attestProjectionDatabaseIdentity(pool, env.VNS_P2_FEED_PROJECTION_DB_USER);
    const privileges = await pool.query(`SELECT
      has_function_privilege(session_user,
        'vns.project_approved_feed_candidates(text,integer)','EXECUTE') AS guarded,
      has_function_privilege(session_user,
        'vns.project_feed_candidates(text,integer)','EXECUTE') AS unguarded,
      has_table_privilege(session_user,'vns.feed_poll_candidates','SELECT') AS candidates,
      has_table_privilege(session_user,'vns.research_claims','INSERT') AS claims,
      has_table_privilege(session_user,'vns.admin_source_registry','SELECT') AS registry`);
    assert.deepEqual(privileges.rows, [
      { guarded: true, unguarded: false, candidates: false, claims: false, registry: false },
    ]);
    // Neither a forged feed ID nor an unset approval registry is writable.
    await assert.rejects(
      projectApprovedSource(pool, readProjectionAdmission(env)),
      /approved source projection unavailable/,
    );
    const articles = await pool.query(
      "SELECT count(*)::integer AS amount FROM pg_catalog.pg_class WHERE relname='research_articles'",
    );
    assert.equal(articles.rows.length, 1);
  } finally {
    await pool.end();
  }
});
