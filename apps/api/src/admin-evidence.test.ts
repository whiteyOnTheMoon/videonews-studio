import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AdminAuth } from "./auth.js";
import { AdminJobs } from "./admin-jobs.js";
import {
  AdminEvidence, parseReview, type EvidenceReviewStore, type EvidenceSummary,
} from "./admin-evidence.js";
import { createApiServer } from "./server.js";

const ORIGIN = "https://studio.example.invalid";
const SALT = Buffer.alloc(16, 53);
const PASS = "ci-editor-admin-password";
const HASH = `scrypt$${SALT.toString("hex")}$${scryptSync(PASS, SALT, 64, {
  N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
}).toString("hex")}`;
const JOB = "12345678-1234-4123-8123-123456789012";
const ID = "87654321-4321-4432-8432-210987654321";
const ITEM: EvidenceSummary = {
  id: ID, jobId: JOB, sourceUrl: "https://www.example.org/report",
  publisher: "Example Press", headline: "Example report headline",
  claim: "An independently reviewed claim candidate.", status: "candidate", reviewedAt: null,
};

test("only allowlisted evidence review decisions are valid", () => {
  assert.deepEqual(parseReview({ evidenceId: ID, decision: "verified" }),
    { evidenceId: ID, decision: "verified" });
  for (const invalid of [
    null, [], { evidenceId: ID, decision: "candidate" },
    { evidenceId: "bad", decision: "verified" },
    { evidenceId: ID, decision: "verified", reviewer: "spoofed" },
    { evidenceId: ID, decision: "approved" },
  ]) assert.equal(parseReview(invalid), null);
});

test("evidence endpoints require valid admin session and Origin for mutations", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  let reads = 0;
  let writes = 0;
  const store: EvidenceReviewStore = {
    async list() { reads += 1; return [ITEM]; },
    async review() { writes += 1; return "updated"; },
  };
  const jobs = new AdminJobs(auth, {
    async createResearchJob() { return JOB; },
    async listRecentResearchJobs() { return []; },
  }, new AdminEvidence(auth, store));
  const server = createApiServer({ auth, jobs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const listUrl = base + "/admin/evidence?jobId=" + JOB;
    const reviewUrl = base + "/admin/evidence/review";
    const body = JSON.stringify({ evidenceId: ID, decision: "verified" });
    const post = (cookie: string | undefined, origin = ORIGIN, payload = body) =>
      fetch(reviewUrl, { method: "POST", headers: {
        "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      }, body: payload });
    assert.equal((await fetch(listUrl)).status, 401);
    assert.equal((await post(undefined)).status, 401);
    const login = await fetch(base + "/auth/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASS }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const listed = await fetch(listUrl, { headers: { Cookie: cookie } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { evidence: [ITEM] });
    assert.equal(listed.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(base + "/admin/evidence?jobId=bad", { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(listUrl + "&extra=1", { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await post(cookie, "https://evil.invalid")).status, 403);
    assert.equal((await post(cookie, ORIGIN, JSON.stringify({ evidenceId: ID, decision: "candidate" }))).status, 400);
    assert.equal((await post(cookie, ORIGIN, "x".repeat(1024))).status, 400);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    const approved = await post(cookie);
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { reviewed: true });
    assert.equal(writes, 1);
    const logout = await fetch(base + "/auth/logout", {
      method: "POST", headers: { Origin: ORIGIN, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.equal((await post(cookie)).status, 401);
    assert.equal((await fetch(listUrl, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reviewed evidence is immutable and failures sanitized through API", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  const fake: EvidenceReviewStore = {
    async list() { throw new Error("secret-pg-host"); },
    async review() { return "already_reviewed"; },
  };
  const jobs = new AdminJobs(auth, {
    async createResearchJob() { return JOB; },
    async listRecentResearchJobs() { return []; },
  }, new AdminEvidence(auth, fake));
  const server = createApiServer({ auth, jobs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(base + "/auth/login", {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASS }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const failed = await fetch(base + "/admin/evidence?jobId=" + JOB, { headers: { Cookie: cookie } });
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes("secret-pg-host"));
    const review = await fetch(base + "/admin/evidence/review", {
      method: "POST", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ evidenceId: ID, decision: "rejected" }),
    });
    assert.equal(review.status, 409);
    assert.deepEqual(await review.json(), { error: "already_reviewed" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
