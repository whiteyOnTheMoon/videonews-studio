// Disposable CI PostgreSQL only. Validate additive NOLOGIN roles without assigning logins.
import assert from "node:assert/strict";
import pg from "pg";
if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("CI-only role acceptance");
}
const { Pool } = pg;
const db = new Pool({
  host: "127.0.0.1",
  port: 15432,
  database: "videonews",
  user: "vns",
  password: "ci-outbox-test-only-not-a-real-secret",
});
const expected = {
  vns_outbox_dispatch: {
    allow: ["vns.jobs:SELECT", "vns.job_outbox:SELECT", "vns.job_outbox:UPDATE"],
    deny: ["vns.jobs:UPDATE", "vns.research_evidence:INSERT", "vns.job_outbox:DELETE"],
  },
  vns_job_status_sync: {
    allow: ["vns.jobs:SELECT", "vns.jobs:UPDATE", "vns.job_outbox:SELECT"],
    deny: ["vns.job_outbox:UPDATE", "vns.jobs:DELETE", "vns.research_evidence:INSERT"],
  },
  vns_research_writer: {
    allow: ["vns.jobs:SELECT", "vns.research_requests:SELECT", "vns.research_evidence:INSERT"],
    deny: ["vns.jobs:UPDATE", "vns.job_outbox:SELECT", "vns.research_evidence:UPDATE"],
  },
};
try {
  for (const [role, policy] of Object.entries(expected)) {
    const roleRow = await db.query("SELECT rolcanlogin, rolsuper, rolcreaterole FROM pg_roles WHERE rolname=$1", [role]);
    assert.deepEqual(roleRow.rows, [{ rolcanlogin: false, rolsuper: false, rolcreaterole: false }]);
    for (const [allowed, specs] of [[true, policy.allow], [false, policy.deny]]) {
      for (const spec of specs) {
        const [table, privilege] = spec.split(":");
        const result = await db.query(
          "SELECT has_table_privilege($1, $2, $3) AS allowed",
          [role, table, privilege],
        );
        assert.equal(result.rows[0].allowed, allowed, role + " " + spec);
      }
    }
  }
  for (const [role, table, column, privilege, allowed] of [
    ["vns_outbox_dispatch", "vns.job_outbox", "delivery_state", "UPDATE", true],
    ["vns_outbox_dispatch", "vns.job_outbox", "job_id", "UPDATE", false],
    ["vns_job_status_sync", "vns.jobs", "status", "UPDATE", true],
    ["vns_job_status_sync", "vns.jobs", "id", "UPDATE", false],
    ["vns_research_writer", "vns.research_evidence", "review_status", "UPDATE", false],
  ]) {
    const result = await db.query(
      "SELECT has_column_privilege($1, $2, $3, $4) AS allowed",
      [role, table, column, privilege],
    );
    assert.equal(result.rows[0].allowed, allowed, role + " " + column);
  }
  console.log("PASS: three dormant no-login roles enforce table and column grants");
} finally {
  await db.end();
}
