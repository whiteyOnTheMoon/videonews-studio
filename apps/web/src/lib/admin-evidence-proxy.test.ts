import assert from "node:assert/strict";
import test from "node:test";
import { listAdminEvidence, submitAdminEvidenceReview } from "./admin-evidence-proxy";

const CONFIG = { origin: "https://studio.example.invalid", api: "http://api:4000" };
const COOKIE = "__Host-vns_session=" + "f".repeat(64);
const JOB = "12345678-1234-4123-8123-123456789012";
const ID = "87654321-4321-4432-8432-210987654321";
const REASON = "The submitted citation confirms the statement in its original context.";
const EVIDENCE = {
  id: ID,
  jobId: JOB,
  sourceUrl: "https://www.example.org/report",
  publisher: "Example Press",
  headline: "Report on local investments",
  claim: "A candidate awaiting editorial review.",
  status: "candidate",
  reviewedAt: null,
};

function get(cookie: string | null = COOKIE) {
  return new Request(CONFIG.origin + "/api/admin/evidence?jobId=" + JOB, {
    method: "GET",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function post(value: unknown, headers: Record<string, string> = {}) {
  return new Request(CONFIG.origin + "/api/admin/evidence/review", {
    method: "POST",
    headers: {
      Origin: CONFIG.origin,
      Cookie: COOKIE,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(value),
  });
}

test("read-only evidence proxy forwards only session and strips private metadata", async () => {
  let invoked = 0;
  const fake: typeof fetch = async (url, init) => {
    invoked += 1;
    assert.equal(url, CONFIG.api + "/admin/evidence?jobId=" + JOB);
    assert.equal(new Headers(init?.headers).get("cookie"), COOKIE);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(init?.redirect, "manual");
    return Response.json({ evidence: [EVIDENCE], private: "hidden" });
  };
  assert.equal((await listAdminEvidence(get(), null, fake)).status, 404);
  assert.equal((await listAdminEvidence(get(null), CONFIG, fake)).status, 401);
  assert.equal(
    (
      await listAdminEvidence(
        new Request(CONFIG.origin + "/api/admin/evidence?jobId=bogus"),
        CONFIG,
        fake,
      )
    ).status,
    400,
  );
  const success = await listAdminEvidence(get(), CONFIG, fake);
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "no-store");
  assert.deepEqual(await success.json(), { evidence: [EVIDENCE] });
  assert.equal(invoked, 1);
});

test("evidence proxy rejects invalid upstream content and no-store errors", async () => {
  const invalid: typeof fetch = async () =>
    Response.json({ evidence: [{ ...EVIDENCE, private: "secret" }] });
  assert.equal((await listAdminEvidence(get(), CONFIG, invalid)).status, 503);
  const large: typeof fetch = async () =>
    Response.json({ evidence: Array.from({ length: 21 }, () => EVIDENCE) });
  assert.equal((await listAdminEvidence(get(), CONFIG, large)).status, 503);
  const failed: typeof fetch = async () => {
    throw new Error("private db host");
  };
  const reply = await listAdminEvidence(get(), CONFIG, failed);
  assert.deepEqual(await reply.json(), { error: "temporarily_unavailable" });
});

test("write proxy requires Origin, cookie and one allowlisted decision", async () => {
  let invoked = 0;
  const fake: typeof fetch = async (url, init) => {
    invoked += 1;
    assert.equal(url, CONFIG.api + "/admin/evidence/review");
    assert.deepEqual(JSON.parse(init?.body as string), {
      evidenceId: ID,
      decision: "verified",
      reason: REASON,
    });
    assert.equal(new Headers(init?.headers).get("cookie"), COOKIE);
    assert.equal(new Headers(init?.headers).get("origin"), CONFIG.origin);
    return Response.json({ reviewed: true, private: "secret" });
  };
  const valid = { evidenceId: ID, decision: "verified", reason: REASON };
  assert.equal((await submitAdminEvidenceReview(post(valid), null, fake)).status, 404);
  assert.equal(
    (await submitAdminEvidenceReview(post(valid, { Origin: "https://evil.invalid" }), CONFIG, fake))
      .status,
    403,
  );
  assert.equal(
    (await submitAdminEvidenceReview(post(valid, { Cookie: "other=forged" }), CONFIG, fake)).status,
    401,
  );
  assert.equal(
    (await submitAdminEvidenceReview(post({ ...valid, reviewer: "impersonated" }), CONFIG, fake))
      .status,
    400,
  );
  assert.equal(
    (
      await submitAdminEvidenceReview(
        post({ evidenceId: ID, decision: "candidate", reason: REASON }),
        CONFIG,
        fake,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await submitAdminEvidenceReview(
        post({ evidenceId: "invalid", decision: "verified" }),
        CONFIG,
        fake,
      )
    ).status,
    400,
  );
  assert.equal(
    (await submitAdminEvidenceReview(post({ evidenceId: ID, decision: "verified" }), CONFIG, fake))
      .status,
    400,
  );
  assert.equal(
    (
      await submitAdminEvidenceReview(
        post({ evidenceId: ID, decision: "verified", reason: "short" }),
        CONFIG,
        fake,
      )
    ).status,
    400,
  );
  assert.equal(invoked, 0);
  const success = await submitAdminEvidenceReview(post(valid), CONFIG, fake);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { reviewed: true });
  assert.equal(invoked, 1);
});

test("review conflict is preserved without exposing upstream details", async () => {
  const conflict: typeof fetch = async () =>
    Response.json({ secret: "SQL credentials" }, { status: 409 });
  const result = await submitAdminEvidenceReview(
    post({ evidenceId: ID, decision: "rejected", reason: REASON }),
    CONFIG,
    conflict,
  );
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: "already_reviewed" });
});
