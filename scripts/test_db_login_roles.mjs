// P1-07: GitHub Actions ONLY. Disposable Postgres login isolation smoke test.
// Does not create application login users or modify any production database.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import {
  replayVerifiedCiAuditEvents,
  signCiAuditManifest,
  verifySignedCiAuditBundle,
} from "./ci_signed_audit_replay.mjs";
import { join } from "node:path";
import pg from "pg";
import { exportCiAuditBundle, verifyCiAuditBundle } from "./ci_audit_export.mjs";
import { AdminAuth } from "../apps/api/dist/auth.js";
import { AdminJobs } from "../apps/api/dist/admin-jobs.js";
import { AdminEvidence } from "../apps/api/dist/admin-evidence.js";
import { EditorAuth, PostgresEditorStore } from "../apps/api/dist/editor-auth.js";
import { createApiServer } from "../apps/api/dist/server.js";

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
  ["vns_ci_govern_login", "vns_operator_governor"],
  ["vns_ci_audit_login", "vns_audit_reader"],
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

  const [api, dispatcher, provisioner, governor, audit] = clients;
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

  // Authenticate a named editor through a real HTTP API backed by the
  // restricted LOGIN, not by the database owner.
  const reviewerPassword = "ci-scoped-login-review-password";
  const salt = Buffer.alloc(16, 69);
  const hash =
    "scrypt$" +
    salt.toString("hex") +
    "$" +
    scryptSync(reviewerPassword, salt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString("hex");
  // An independently authenticated synthetic governance LOGIN, without
  // owner rights, registers the ephemeral provisioner via the scoped function.
  await refuses(provisioner, "SELECT * FROM vns.editor_operator_registry");
  await refuses(provisioner, "SELECT vns.register_editor_operator($1::name,$2::uuid,$3,$4)", [
    "vns_ci_provision_login",
    "cccccccc-1234-4123-8123-cccccccccccc",
    "CI Provisioning Operator",
    "Unauthorized self-enrollment attempt is refused.",
  ]);
  await refuses(
    governor,
    "INSERT INTO vns.editor_operator_registry(login_role,operator_id,operator_label) VALUES ($1,$2,$3)",
    ["vns_ci_provision_login", "cccccccc-1234-4123-8123-cccccccccccc", "Forged Operator"],
  );
  await governor.query("SELECT vns.register_editor_operator($1::name,$2::uuid,$3,$4)", [
    "vns_ci_provision_login",
    "cccccccc-1234-4123-8123-cccccccccccc",
    "Synthetic CI Provisioning Operator",
    "Independent disposable CI governance approval for account maintenance.",
  ]);
  const registered = await owner.query(
    "SELECT operator_login FROM vns.editor_account_lifecycle_events WHERE operator_login=$1",
    ["vns_ci_provision_login"],
  );
  assert.equal(registered.rowCount, 0);
  const inserted = await provisioner.query(
    "INSERT INTO vns.editor_accounts (username,display_name,role,password_hash) " +
      "VALUES ('ci_login_probe','CI Login Probe','reviewer',$1) " +
      "RETURNING username, active, role",
    [hash],
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

  // Runtime role still cannot lock editor accounts or directly change
  // evidence. The sole permitted path is the scoped SQL review function.
  await refuses(
    api,
    "SELECT username,role FROM vns.editor_accounts " + "WHERE username='ci_login_probe' FOR SHARE",
  );
  await refuses(api, "SET ROLE vns_editor_review_executor");
  const evidence = await owner.query(
    `INSERT INTO vns.research_evidence
       (job_id,source_url,publisher,headline,claim_text)
       VALUES ($1::uuid,'https://example.org/ci-scoped-login','CI Test Publisher',
               'Scoped real login review','A synthetic fact-check source claim.')
       RETURNING id::text AS id`,
    [job.rows[0].id],
  );
  const evidenceId = evidence.rows[0].id;
  await refuses(api, "UPDATE vns.research_evidence SET review_status='verified'");
  const origin = "https://studio.example.invalid";
  const adminPassword = "ci-scoped-login-shared-admin-password";
  const adminSalt = Buffer.alloc(16, 71);
  const adminHash =
    "scrypt$" +
    adminSalt.toString("hex") +
    "$" +
    scryptSync(adminPassword, adminSalt, 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    }).toString("hex");
  const auth = new AdminAuth({ passwordHash: adminHash, origin });
  const jobs = new AdminJobs(
    auth,
    {
      async createResearchJob() {
        return job.rows[0].id;
      },
      async listRecentResearchJobs() {
        return [];
      },
    },
    new AdminEvidence(
      auth,
      {
        async list() {
          return [];
        },
        async review() {
          return "updated";
        },
      },
      false,
    ),
  );
  const editor = new EditorAuth(new PostgresEditorStore(api), origin);
  const server = createApiServer({ auth, jobs, editor });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port;
    const login = (password) =>
      fetch(base + "/editor/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "ci_login_probe", password }),
      });
    const loggedIn = await login(reviewerPassword);
    assert.equal(loggedIn.status, 200);
    const cookie = loggedIn.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const review = (session, id) =>
      fetch(base + "/editor/evidence/review", {
        method: "POST",
        headers: { Origin: origin, Cookie: session, "Content-Type": "application/json" },
        body: JSON.stringify({
          evidenceId: id,
          decision: "disputed",
          reason: "This sample source does not establish the complete claim.",
        }),
      });
    assert.equal((await review(cookie, evidenceId)).status, 200);
    assert.equal((await review(cookie, evidenceId)).status, 409);
    const audited = await owner.query(
      `SELECT reviewer_label, editor_id::text AS editor_id,
              after_status, reason FROM vns.evidence_review_events
       WHERE evidence_id=$1::uuid`,
      [evidenceId],
    );
    assert.equal(audited.rowCount, 1);
    assert.equal(audited.rows[0].reviewer_label, "ci_login_probe");
    assert.equal(audited.rows[0].after_status, "disputed");
    assert.equal(
      audited.rows[0].reason,
      "This sample source does not establish the complete claim.",
    );
    const namedId = await owner.query(
      "SELECT id::text AS id FROM vns.editor_accounts WHERE username='ci_login_probe'",
    );
    assert.equal(audited.rows[0].editor_id, namedId.rows[0].id);

    // Account demotion invalidates the cookie and denies a fresh review.
    await provisioner.query(
      "UPDATE vns.editor_accounts SET role='editor' WHERE username='ci_login_probe'",
    );
    assert.equal((await review(cookie, evidenceId)).status, 401);
    const afterDemotion = await login(reviewerPassword);
    assert.equal(afterDemotion.status, 200);
    const downgradedCookie = afterDemotion.headers.get("set-cookie")?.split(";")[0];
    assert.ok(downgradedCookie);
    assert.equal((await review(downgradedCookie, evidenceId)).status, 403);
    await provisioner.query(
      "UPDATE vns.editor_accounts SET active=false WHERE username='ci_login_probe'",
    );
    assert.equal((await login(reviewerPassword)).status, 401);
    assert.equal((await review(downgradedCookie, evidenceId)).status, 401);
    console.log(
      "PASS: restricted PostgreSQL LOGIN authenticates, reviews, audits and revokes via HTTP",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // The parent cleanup closes the restricted API pool.
  }
  // Revocation is separately authenticated and fully audited. A revoked
  // operator can no longer mutate accounts, despite retaining table GRANTs.
  await governor.query("SELECT vns.revoke_editor_operator($1::name,$2)", [
    "vns_ci_provision_login",
    "Synthetic governance revocation after completing isolated CI checks.",
  ]);
  const governanceEvents = await owner.query(
    `SELECT event_type,authorized_by,login_role
       FROM vns.editor_operator_registry_events
      WHERE login_role='vns_ci_provision_login' ORDER BY recorded_at,id`,
  );
  assert.deepEqual(
    governanceEvents.rows.map((row) => row.event_type),
    ["registered", "revoked"],
  );
  assert.ok(governanceEvents.rows.every((row) => row.authorized_by === "vns_ci_govern_login"));
  await refuses(
    provisioner,
    "UPDATE vns.editor_accounts SET active=true WHERE username='ci_login_probe'",
  );
  await assert.rejects(
    governor.query("SELECT vns.revoke_editor_operator($1::name,$2)", [
      "vns_ci_provision_login",
      "Repeat revocation should fail closed, not double-log.",
    ]),
    (error) => error?.code === "22023",
  );
  await refuses(api, "SELECT * FROM vns.editor_operator_registry_events");
  await refuses(governor, "DELETE FROM vns.editor_operator_registry_events");
  // The export uses an independently authenticated, READ-ONLY LOGIN.
  await refuses(audit, "SELECT username FROM vns.editor_accounts");
  await refuses(audit, "UPDATE vns.editor_operator_registry_events SET event_type='revoked'");
  await refuses(audit, "SELECT * FROM vns.editor_operator_registry");
  const output = await exportCiAuditBundle(audit);
  try {
    const verified = await verifyCiAuditBundle(output);
    assert.deepEqual(
      verified.streams.map((item) => item.stream),
      ["source_reviews", "editor_lifecycle", "operator_governance"],
    );
    assert.ok(verified.streams.every((item) => item.rows > 0));
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    assert.equal(manifest.streams.length, 3);
    const allText = await Promise.all(
      manifest.streams.map((item) => readFile(join(output, item.file), "utf8")),
    );
    assert.ok(allText.every((text) => !text.includes("password_hash")));
    assert.ok(allText.every((text) => !text.includes("scrypt$")));
    const name = manifest.streams[1].file;
    const original = await readFile(join(output, name));
    try {
      await writeFile(join(output, name), Buffer.concat([original, Buffer.from("tamper")]));
      await assert.rejects(verifyCiAuditBundle(output), /mismatch/);
    } finally {
      await writeFile(join(output, name), original);
    }
    await verifyCiAuditBundle(output);
    const changed = structuredClone(manifest);
    changed.streams[0].rows += 1;
    await writeFile(join(output, "manifest.json"), JSON.stringify(changed) + "\n");
    await assert.rejects(verifyCiAuditBundle(output), /mismatch/);
    await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await verifyCiAuditBundle(output);
    // Trusted verification key is passed OUTSIDE the archive. The ephemeral
    // signing key exists in memory for this CI run only.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const attacker = generateKeyPairSync("ed25519");
    await signCiAuditManifest(output, privateKey);
    await verifySignedCiAuditBundle(output, publicKey);
    const recovered = await replayVerifiedCiAuditEvents(output, publicKey);
    assert.deepEqual(
      recovered.map((item) => item.stream),
      ["source_reviews", "editor_lifecycle", "operator_governance"],
    );
    assert.ok(recovered.every((item) => item.rows > 0));
    await assert.rejects(
      verifySignedCiAuditBundle(output, attacker.publicKey),
      /signature verification failed/,
    );
    const signedManifest = await readFile(join(output, "manifest.json"));
    const trustedSignature = await readFile(join(output, "manifest.sig"));
    const falsified = structuredClone(JSON.parse(signedManifest.toString("utf8")));
    falsified.streams[0].rows += 1;
    try {
      await writeFile(join(output, "manifest.json"), JSON.stringify(falsified) + "\n");
      await assert.rejects(
        verifySignedCiAuditBundle(output, publicKey),
        /signature verification failed/,
      );
    } finally {
      await writeFile(join(output, "manifest.json"), signedManifest);
    }
    const modifiedSignature = Buffer.from(trustedSignature);
    modifiedSignature[0] ^= 0x01;
    try {
      await writeFile(join(output, "manifest.sig"), modifiedSignature);
      await assert.rejects(
        verifySignedCiAuditBundle(output, publicKey),
        /signature verification failed/,
      );
    } finally {
      await writeFile(join(output, "manifest.sig"), trustedSignature);
    }
    // An attacker who controls both archive and signature but NOT the
    // externally pinned public key cannot replace the trusted signer.
    await rm(join(output, "manifest.sig"));
    await signCiAuditManifest(output, attacker.privateKey);
    await verifySignedCiAuditBundle(output, attacker.publicKey);
    await assert.rejects(
      replayVerifiedCiAuditEvents(output, publicKey),
      /signature verification failed/,
    );
    await writeFile(join(output, "manifest.sig"), trustedSignature);
    assert.deepEqual(await replayVerifiedCiAuditEvents(output, publicKey), recovered);
    console.log("PASS: detached Ed25519 signature and offline replay reject untrusted signer");
    console.log("PASS: read-only three-ledger export, hashes and tamper rejection");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
  console.log("PASS: authenticated governor registers, audits and revokes provisioner");
  console.log("PASS: separate disposable LOGINs honor runtime/provisioning boundaries");
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
