// Only disposable PostgreSQL started by db/scripts/test_worker_queue.sh.
// These fixed credentials are test fixtures, never operational secrets.
import assert from "node:assert/strict";
import pg from "pg";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Disposable GitHub Actions database required");
}

const connection = {
  host: "127.0.0.1",
  port: 15432,
  database: "videonews",
  connectionTimeoutMillis: 4000,
};
const admin = new pg.Client({
  ...connection,
  user: "vns",
  password: "ci-outbox-test-only-not-a-real-secret",
});
const identities = [
  {
    login: "vns_outbox_dispatch_login",
    group: "vns_outbox_dispatch",
    password: "ci-dispatch-fixture-only-not-a-real-secret-0001",
    allow: "SELECT job_id FROM vns.job_outbox LIMIT 0",
    deny: "UPDATE vns.jobs SET status = 'done' WHERE false",
  },
  {
    login: "vns_job_status_sync_login",
    group: "vns_job_status_sync",
    password: "ci-status-fixture-only-not-a-real-secret-0002",
    allow: "SELECT id FROM vns.jobs LIMIT 0",
    deny: "UPDATE vns.job_outbox SET delivery_state = 'pending' WHERE false",
  },
  {
    login: "vns_research_writer_login",
    group: "vns_research_writer",
    password: "ci-research-fixture-only-not-a-real-secret-0003",
    allow: "SELECT topic FROM vns.research_requests LIMIT 0",
    deny: "SELECT job_id FROM vns.job_outbox LIMIT 0",
  },
];

await admin.connect();
try {
  for (const identity of identities) {
    // All identifiers are fixed test literals above; passwords are parameters.
    await admin.query(`CREATE ROLE "${identity.login}" LOGIN INHERIT PASSWORD '${identity.password}'`);
    await admin.query(`GRANT "${identity.group}" TO "${identity.login}"`);
    const role = await admin.query(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=$1",
      [identity.login],
    );
    assert.deepEqual(role.rows, [
      { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false },
    ]);
  }
  for (const identity of identities) {
    const client = new pg.Client({
      ...connection,
      user: identity.login,
      password: identity.password,
    });
    await client.connect();
    try {
      const current = await client.query("SELECT current_user AS identity");
      assert.equal(current.rows[0].identity, identity.login);
      await client.query(identity.allow);
      await assert.rejects(client.query(identity.deny), (error) => error.code === "42501");
      const owner = await client.query("SELECT pg_has_role(current_user, 'vns', 'MEMBER') AS member");
      assert.equal(owner.rows[0].member, false);
      console.log(`PASS: scoped login ${identity.login} authenticates and denies cross-service SQL`);
    } finally {
      await client.end();
    }
  }
} finally {
  await admin.end();
}
