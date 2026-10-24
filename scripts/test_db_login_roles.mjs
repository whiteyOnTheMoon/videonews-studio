// P1-07: GitHub Actions ONLY. Disposable Postgres login isolation smoke test.
// Does not create application login users or modify any production database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";

const expected = {
  GITHUB_ACTIONS: "true",
  CI: "true",
  GITHUB_REPOSITORY: "whiteyOnTheMoon/videonews-studio",
  VNS_CI_ROLE_LOGIN_PROBE: "true",
};
for (const [key, value] of Object.entries(expected)) {
  if (process.env[key] !== value) throw new Error("REFUSED: disposable GitHub Actions only");
}
if (!/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")) {
  throw new Error("REFUSED: GitHub Actions run ID required");
}

const connection = {
  host: "127.0.0.1",
  port: 15434,
  database: "videonews",
  connectionTimeoutMillis: 4000,
  max: 1,
};
const owner = new pg.Pool({
  ...connection,
  user: "vns",
  password: "ci-outbox-only-not-a-real-password",
});
const assignments = [
  ["vns_ci_api_login", "vns_api_runtime"],
  ["vns_ci_dispatch_login", "vns_outbox_dispatcher"],
  ["vns_ci_provision_login", "vns_editor_provisioner"],
];
const clients = [];
let created = 0;
const refuses = async (pool, sql, params = []) => {
  await assert.rejects(pool.query(sql, params), (error) => error?.code === "42501");
};

try {
  const identity = await owner.query("SELECT current_user AS account, current_database() AS db");
  assert.equal(identity.rows[0].account, "vns");
  assert.equal(identity.rows[0].db, "videonews");

  for (const [login, role] of assignments) {
    // Random test-only passwords are not written to logs, files or GitHub secrets.
    const password = randomBytes(32).toString("hex");
    // Identifier and password formats are fixed here, not supplied by a user.
    await owner.query(
      "CREATE ROLE " +
        login +
        " LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION " +
        "CONNECTION LIMIT 2 PASSWORD '" +
        password +
        "'",
    );
    created += 1;
    await owner.query(
      "GRANT " + role + " TO " + login + " WITH INHERIT TRUE, SET FALSE, ADMIN FALSE",
    );
    const pool = new pg.Pool({ ...connection, user: login, password });
    clients.push(pool);
    const who = await pool.query("SELECT session_user, current_user");
    assert.equal(who.rows[0].session_user, login);
    assert.equal(who.rows[0].current_user, login);
    await refuses(pool, "SET ROLE vns");
    await refuses(pool, "SET ROLE vns_review_event_writer");
  }

  const [api, dispatcher, provisioner] = clients;
  const job = await api.query("SELECT vns.create_research_request($1, $2) AS id", [
    "ci-real-login-role-job-00001",
    "Disposable separated database login access test",
  ]);
  assert.match(job.rows[0].id, /^[0-9a-f-]{36}$/);
  const same = await api.query("SELECT vns.create_research_request($1, $2) AS id", [
    "ci-real-login-role-job-00001",
    "Disposable separated database login access test",
  ]);
  assert.equal(same.rows[0].id, job.rows[0].id);
  await refuses(api, "INSERT INTO vns.editor_accounts (username) VALUES ('ci_forged')");
  await refuses(api, "SELECT * FROM vns.evidence_review_events");

  const pending = await dispatcher.query(
    "SELECT delivery_state FROM vns.job_outbox WHERE job_id=$1",
    [job.rows[0].id],
  );
  assert.equal(pending.rows[0].delivery_state, "pending");
  const acknowledged = await dispatcher.query(
    "UPDATE vns.job_outbox SET delivery_state='enqueued', " +
      "dispatch_attempts=dispatch_attempts + 1, " +
      "last_attempt_at=clock_timestamp(), enqueued_at=clock_timestamp() " +
      "WHERE job_id=$1 RETURNING delivery_state, dispatch_attempts",
    [job.rows[0].id],
  );
  assert.equal(acknowledged.rows[0].delivery_state, "enqueued");
  assert.equal(acknowledged.rows[0].dispatch_attempts, 1);
  await refuses(dispatcher, "SELECT password_hash FROM vns.editor_accounts");
  await refuses(dispatcher, "UPDATE vns.research_evidence SET review_status='verified'");
  await refuses(dispatcher, "SELECT vns.create_research_request($1,$2)", [
    "ci-unauthorized-job-00001",
    "Unauthorized dispatcher job creation attempt",
  ]);

  const inserted = await provisioner.query(
    "INSERT INTO vns.editor_accounts (username,display_name,role,password_hash) " +
      "VALUES ('ci_login_probe','CI Login Probe','reviewer',$1) " +
      "RETURNING username, active, role",
    ["scrypt$" + "a".repeat(32) + "$" + "b".repeat(128)],
  );
  assert.equal(inserted.rows[0].active, false);
  assert.equal(inserted.rows[0].role, "reviewer");
  await refuses(provisioner, "SELECT password_hash FROM vns.editor_accounts");
  await refuses(
    provisioner,
    "INSERT INTO vns.editor_accounts (username,display_name,role,password_hash,active) " +
      "VALUES ('ci_forged','Forged', 'admin', $1, true)",
    ["scrypt$" + "a".repeat(32) + "$" + "b".repeat(128)],
  );
  await provisioner.query(
    "UPDATE vns.editor_accounts SET active=true WHERE username='ci_login_probe'",
  );
  const activated = await owner.query(
    "SELECT active,auth_version FROM vns.editor_accounts WHERE username='ci_login_probe'",
  );
  assert.equal(activated.rows[0].active, true);
  assert.equal(activated.rows[0].auth_version, 1);
  await refuses(provisioner, "DELETE FROM vns.editor_accounts");
  await refuses(provisioner, "SELECT * FROM vns.evidence_review_events");

  // IMPORTANT: the existing API uses SELECT ... FOR SHARE for editor review.
  // PostgreSQL requires UPDATE permission for that lock, intentionally absent
  // from vns_api_runtime. Detect the gap without granting unsafe account writes.
  await refuses(
    api,
    "SELECT username,role FROM vns.editor_accounts " + "WHERE username='ci_login_probe' FOR SHARE",
  );
  console.log("PASS: separate disposable LOGINs honor runtime/provisioning boundaries");
  console.log("KNOWN GATE: named review row lock still requires a safer SQL authorization design");
} finally {
  await Promise.allSettled(clients.map((pool) => pool.end()));
  // Roll back only the three hardcoded, test-only login roles on the isolated DB.
  for (let i = created - 1; i >= 0; i -= 1) {
    const [login, role] = assignments[i];
    try {
      await owner.query("REVOKE " + role + " FROM " + login);
      await owner.query("DROP ROLE " + login);
    } catch {
      // Disposable container cleanup remains the ultimate boundary.
    }
  }
  await owner.end();
}
