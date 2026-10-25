// Disposable CI PostgreSQL only. Validate additive NOLOGIN roles without assigning logins.
import assert from "node:assert/strict";
import pg from "pg";
import { readFileSync } from "node:fs";
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
    allow: ["vns.jobs:SELECT", "vns.job_outbox:SELECT"],
    deny: ["vns.jobs:UPDATE", "vns.research_evidence:INSERT", "vns.job_outbox:DELETE"],
  },
  vns_job_status_sync: {
    allow: ["vns.jobs:SELECT", "vns.job_outbox:SELECT"],
    deny: ["vns.job_outbox:UPDATE", "vns.jobs:DELETE", "vns.research_evidence:INSERT"],
  },
  vns_research_writer: {
    allow: ["vns.jobs:SELECT", "vns.research_requests:SELECT", "vns.research_evidence:INSERT"],
    deny: ["vns.jobs:UPDATE", "vns.job_outbox:SELECT", "vns.research_evidence:UPDATE"],
  },
};
try {
  await db.query(readFileSync("db/migrations/0012_runtime_least_privilege.up.sql", "utf8"));
  for (const [role, policy] of Object.entries(expected)) {
    const roleRow = await db.query(
      "SELECT rolcanlogin, rolsuper, rolcreaterole FROM pg_roles WHERE rolname=$1",
      [role],
    );
    assert.deepEqual(roleRow.rows, [{ rolcanlogin: false, rolsuper: false, rolcreaterole: false }]);
    for (const [allowed, specs] of [
      [true, policy.allow],
      [false, policy.deny],
    ]) {
      for (const spec of specs) {
        const [table, privilege] = spec.split(":");
        const result = await db.query("SELECT has_table_privilege($1, $2, $3) AS allowed", [
          role,
          table,
          privilege,
        ]);
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
    const result = await db.query("SELECT has_column_privilege($1, $2, $3, $4) AS allowed", [
      role,
      table,
      column,
      privilege,
    ]);
    assert.equal(result.rows[0].allowed, allowed, role + " " + column);
  }
  // Metadata checks alone do not prove SQL is executable with SET ROLE.
  // Every probe rolls back, touches zero rows, and uses only disposable CI PG.
  const probes = [
    ["vns_outbox_dispatch", "SELECT job_id FROM vns.job_outbox LIMIT 0", true],
    [
      "vns_outbox_dispatch",
      "UPDATE vns.job_outbox SET delivery_state = 'pending' WHERE false",
      true,
    ],
    [
      "vns_outbox_dispatch",
      "UPDATE vns.job_outbox SET queue_job_id = 'forbidden' WHERE false",
      false,
    ],
    ["vns_outbox_dispatch", "UPDATE vns.jobs SET status = 'done' WHERE false", false],
    ["vns_job_status_sync", "SELECT id FROM vns.jobs LIMIT 0", true],
    ["vns_job_status_sync", "UPDATE vns.jobs SET status = 'retry' WHERE false", true],
    ["vns_job_status_sync", "UPDATE vns.jobs SET kind = 'render' WHERE false", false],
    [
      "vns_job_status_sync",
      "UPDATE vns.job_outbox SET delivery_state = 'pending' WHERE false",
      false,
    ],
    ["vns_research_writer", "SELECT topic FROM vns.research_requests LIMIT 0", true],
    [
      "vns_research_writer",
      "INSERT INTO vns.research_evidence (job_id, source_url, publisher, headline, claim_text) SELECT NULL::uuid, '', '', '', '' WHERE false",
      true,
    ],
    [
      "vns_research_writer",
      "UPDATE vns.research_evidence SET review_status = 'verified' WHERE false",
      false,
    ],
    ["vns_research_writer", "SELECT job_id FROM vns.job_outbox LIMIT 0", false],
  ];
  for (const [role, statement, permitted] of probes) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Only hardcoded test role names; never derived from an external value.
      await client.query("SET LOCAL ROLE " + role);
      if (permitted) {
        await client.query(statement);
      } else {
        await assert.rejects(client.query(statement), (error) => error.code === "42501");
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  console.log("PASS: scoped SQL statements enforce runtime role permissions");
  console.log("PASS: three dormant no-login roles enforce table and column grants");
} finally {
  await db.end();
}
