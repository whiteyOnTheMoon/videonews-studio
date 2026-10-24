// Strictly disposable GitHub Actions integration: real PostgreSQL + HTTP
// personal editor sessions, account revocation and immutably audited reviews.
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { once } from "node:events";
import pg from "pg";
import { AdminAuth } from "../apps/api/dist/auth.js";
import { adminJobsFromEnv } from "../apps/api/dist/admin-jobs.js";
import { editorAuthFromEnv } from "../apps/api/dist/editor-auth.js";
import { createApiServer } from "../apps/api/dist/server.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("Editor auth integration is GitHub Actions only");
}
const ORIGIN = "https://studio.example.invalid";
const PASSWORD = "ci-personal-reviewer-password";
const PASS_DISABLED = "ci-disabled-reviewer-password";
const REASON = "The original source limits the claim to the regional reporting period.";
const hashFor = (password, saltByte) => {
  const salt = Buffer.alloc(16, saltByte);
  return "scrypt$" + salt.toString("hex") + "$" + scryptSync(password, salt, 64, {
    N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  }).toString("hex");
};
const auth = new AdminAuth({ passwordHash: hashFor("ci-existing-shared-admin-password", 44), origin: ORIGIN });
const env = {
  VNS_ADMIN_JOBS_ENABLED: "true",
  VNS_EDITOR_AUTH_ENABLED: "true",
  VNS_POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password",
  VNS_POSTGRES_HOST: "127.0.0.1",
  VNS_POSTGRES_PORT: "15434",
  VNS_POSTGRES_DB: "videonews",
  VNS_ADMIN_ORIGIN: ORIGIN,
};
const secret = () => "ci-outbox-only-not-a-real-password";
const jobs = adminJobsFromEnv(auth, env, secret);
assert.ok(jobs);
const editor = editorAuthFromEnv(auth, jobs, env, secret);
assert.ok(editor);
const server = createApiServer({ auth, jobs, editor });
const { Pool } = pg;
const pool = new Pool({
  host: "127.0.0.1", port: 15434, user: "vns", database: "videonews",
  password: "ci-outbox-only-not-a-real-password", connectionTimeoutMillis: 4000,
});
try {
  const reviewer = await pool.query(
    `INSERT INTO vns.editor_accounts (username, display_name, role, active, password_hash)
     VALUES ('ci_reviewer', 'CI Named Reviewer', 'reviewer', true, $1)
     RETURNING id::text AS id`, [hashFor(PASSWORD, 55)],
  );
  const reviewerId = reviewer.rows[0].id;
  await pool.query(
    `INSERT INTO vns.editor_accounts (username, display_name, role, active, password_hash)
     VALUES ('ci_inactive', 'CI Inactive Editor', 'reviewer', false, $1)`,
    [hashFor(PASS_DISABLED, 56)],
  );
  const editorOnly = await pool.query(
    `INSERT INTO vns.editor_accounts (username, display_name, role, active, password_hash)
     VALUES ('ci_writer', 'CI Writer Only', 'editor', true, $1)
     RETURNING id::text AS id`, [hashFor(PASSWORD, 57)],
  );

  const created = await pool.query(
    "SELECT vns.create_research_request($1, $2) AS id",
    ["ci-personal-editor-review-job", "Community budgets and transport safety assessments"],
  );
  const jobId = created.rows[0].id;
  const evidence = await pool.query(
    `INSERT INTO vns.research_evidence
       (job_id, source_url, publisher, headline, claim_text)
     VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id::text AS id`,
    [jobId, "https://www.example.org/editor-review",
      "Example City Archives", "Annual public infrastructure report",
      "The report describes public infrastructure budget assignments."],
  );
  const evidenceId = evidence.rows[0].id;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  const login = (username, password, origin = ORIGIN) => fetch(base + "/editor/auth/login", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const review = (cookie, evidenceId, origin = ORIGIN, payload = {
    evidenceId, decision: "disputed", reason: REASON,
  }) => fetch(base + "/editor/evidence/review", {
    method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  assert.equal((await login("ci_reviewer", PASSWORD, "https://bad.invalid")).status, 403);
  assert.equal((await login("ci_inactive", PASS_DISABLED)).status, 401);
  assert.equal((await login("ci_not_found", PASSWORD)).status, 401);
  const namedLogin = await login("ci_reviewer", PASSWORD);
  assert.equal(namedLogin.status, 200);
  const cookie = namedLogin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("__Host-vns_editor="));
  const me = await fetch(base + "/editor/me", { headers: { Cookie: cookie } });
  assert.deepEqual(await me.json(), { username: "ci_reviewer", role: "reviewer" });
  assert.equal((await review(cookie, evidenceId, "https://attacker.invalid")).status, 403);
  assert.equal((await review(cookie, evidenceId, ORIGIN, {
    evidenceId, decision: "verified", reason: REASON, reviewer: "spoofed",
  })).status, 400);

  const writerLogin = await login("ci_writer", PASSWORD);
  assert.equal(writerLogin.status, 200);
  const writerCookie = writerLogin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(writerCookie);
  assert.equal((await review(writerCookie, evidenceId)).status, 403);
  assert.equal((await review(cookie, evidenceId)).status, 200);
  assert.equal((await review(cookie, evidenceId)).status, 409);

  const audited = await pool.query(
    `SELECT e.review_status, e.reviewer, e.reviewer_editor_id::text AS editor_id,
            e.review_reason, ev.editor_id::text AS audit_editor_id, ev.reviewer_label,
            ev.before_status, ev.after_status, ev.reason
     FROM vns.research_evidence e
     JOIN vns.evidence_review_events ev ON ev.evidence_id = e.id
     WHERE e.id = $1::uuid`,
    [evidenceId],
  );
  assert.equal(audited.rowCount, 1);
  assert.deepEqual(audited.rows[0], {
    review_status: "disputed", reviewer: "ci_reviewer", editor_id: reviewerId,
    review_reason: REASON, audit_editor_id: reviewerId, reviewer_label: "ci_reviewer",
    before_status: "candidate", after_status: "disputed", reason: REASON,
  });
  console.log("PASS: personal reviewer ID and rationale recorded atomically with verdict");

  const sharedLogin = await fetch(base + "/auth/login", {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "ci-existing-shared-admin-password" }),
  });
  const sharedCookie = sharedLogin.headers.get("set-cookie")?.split(";")[0];
  assert.ok(sharedCookie);
  assert.equal((await fetch(base + "/admin/evidence/review", {
    method: "POST", headers: { Cookie: sharedCookie, Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ evidenceId, decision: "verified", reason: REASON }),
  })).status, 403);

  // Revoked or demoted accounts lose authorization without restarting API.
  await pool.query("UPDATE vns.editor_accounts SET role='editor' WHERE id=$1", [reviewerId]);
  assert.equal((await review(cookie, evidenceId)).status, 403);
  await pool.query("UPDATE vns.editor_accounts SET active=false WHERE id=$1", [reviewerId]);
  assert.equal((await fetch(base + "/editor/me", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await review(cookie, evidenceId)).status, 401);
  assert.equal((await login("ci_reviewer", PASSWORD)).status, 401);
  assert.equal((await review(writerCookie, evidenceId)).status, 403);
  const count = await pool.query(
    "SELECT count(*)::int AS n FROM vns.evidence_review_events WHERE evidence_id=$1",
    [evidenceId],
  );
  assert.equal(count.rows[0].n, 1);
  await pool.query("UPDATE vns.editor_accounts SET active=false WHERE id=$1", [editorOnly.rows[0].id]);
  console.log("PASS: immediate revocation, role enforcement, CSRF and shared-session bypass denial");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  await Promise.allSettled([pool.end(), jobs.close(), editor.close()]);
}
