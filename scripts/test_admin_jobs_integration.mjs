// CI-only integration: real HTTP admin auth -> real PostgreSQL job/outbox transaction.
// Never run against a VPS or any persistent database.
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { AddressInfo } from "node:net";
import pg from "pg";
import { AdminAuth } from "../apps/api/dist/auth.js";
import { adminJobsFromEnv } from "../apps/api/dist/admin-jobs.js";
import { createApiServer } from "../apps/api/dist/server.js";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("Admin job integration is GitHub Actions only");
}

const ORIGIN = "https://studio.example.invalid";
const PASS = "ci-only-admin-job-password";
const SALT = Buffer.alloc(16, 31);
const HASH = `scrypt$${SALT.toString("hex")}$${scryptSync(PASS, SALT, 64, {
  N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
}).toString("hex")}`;
const KEY = "ci_job_research_transaction_001";

const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
const adminJobs = adminJobsFromEnv(
  auth,
  {
    VNS_ADMIN_JOBS_ENABLED: "true",
    VNS_POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password",
    VNS_POSTGRES_HOST: "127.0.0.1",
    VNS_POSTGRES_PORT: "15434",
    VNS_POSTGRES_DB: "videonews",
  },
  () => "ci-outbox-only-not-a-real-password",
);
assert.ok(adminJobs);
const server = createApiServer({ auth, jobs: adminJobs });
const { Pool } = pg;
const pool = new Pool({
  host: "127.0.0.1",
  port: 15434,
  user: "vns",
  database: "videonews",
  password: "ci-outbox-only-not-a-real-password",
  connectionTimeoutMillis: 3000,
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const requestBody = JSON.stringify({ kind: "research", idempotencyKey: KEY });
  const send = (cookie, body = requestBody) =>
    fetch(base + "/admin/jobs", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
    });
  assert.equal((await send(null)).status, 401);
  const login = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASS }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const result1 = await send(cookie);
  assert.equal(result1.status, 202);
  const data1 = await result1.json();
  assert.equal(data1.accepted, true);
  const result2 = await send(cookie);
  assert.equal(result2.status, 202);
  const data2 = await result2.json();
  assert.equal(data1.jobId, data2.jobId);

  const db = await pool.query(
    `SELECT j.id::text AS id, j.kind, j.status, ob.delivery_state, ob.queue_job_id
     FROM vns.jobs j JOIN vns.job_outbox ob ON ob.job_id = j.id
     WHERE j.idempotency_key = $1`,
    [KEY],
  );
  assert.equal(db.rowCount, 1);
  assert.equal(db.rows[0].id, data1.jobId);
  assert.equal(db.rows[0].kind, "research");
  assert.equal(db.rows[0].status, "pending");
  assert.equal(db.rows[0].delivery_state, "pending");
  assert.equal(db.rows[0].queue_job_id, "job-" + data1.jobId.replaceAll("-", ""));

  // No queue dispatcher is activated. Nothing gets sent to Redis.
  const wrongOrigin = await fetch(base + "/admin/jobs", {
    method: "POST",
    headers: { Origin: "https://evil.example.invalid", Cookie: cookie, "Content-Type": "application/json" },
    body: requestBody,
  });
  assert.equal(wrongOrigin.status, 403);
  const wrongKind = await send(cookie, JSON.stringify({ kind: "render", idempotencyKey: KEY }));
  assert.equal(wrongKind.status, 400);

  const logout = await fetch(base + "/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  assert.equal(logout.status, 200);
  assert.equal((await send(cookie)).status, 401);
  console.log("PASS: real admin session, atomic job+outbox, repeated idempotency, CSRF and logout");
} finally {
  await pool.end();
  await adminJobs.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}
