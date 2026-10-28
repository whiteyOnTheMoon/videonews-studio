import assert from "node:assert/strict";
import test from "node:test";
import {
  dormantProviderJobSubmissionProxy,
  parseProviderJobSubmission,
  providerJobSubmissionProxyConfig,
} from "./admin-provider-job-submission-proxy";

const ORIGIN = "https://studio.ap-pixels.com";
const CONFIG = { origin: ORIGIN, api: "http://api:4000" };
const COOKIE = "__Host-vns_editor=" + "a".repeat(64);
const JOB = "a4710003-0000-4000-8000-000000000003";
const body = () => ({
  idempotencyKey: "ci_provider_job_submission_0047",
  requestId: "ci_provider_request_0047",
  provider: "openai",
  model: "reviewed-model-47",
  priceSnapshotId: "a4710002-0000-4000-8000-000000000002",
  prompt: "Verified source evidence.",
  maxInputTokens: 100,
  maxOutputTokens: 32,
});
const request = (value: unknown = body(), origin = ORIGIN, cookie = COOKIE) =>
  new Request(ORIGIN + "/api/admin/ai-provider-jobs", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });

test("default off and exact job grammar rejects mutation and provider activation", () => {
  assert.equal(providerJobSubmissionProxyConfig({}), null);
  assert.deepEqual(parseProviderJobSubmission(body()), body());
  for (const invalid of [
    {},
    null,
    { ...body(), apiKey: "not-allowed" },
    { ...body(), enable: true },
    { ...body(), budget: 1 },
    { ...body(), provider: "other" },
    { ...body(), requestId: "short" },
    { ...body(), priceSnapshotId: "bad" },
    { ...body(), prompt: " " },
    { ...body(), prompt: "x".repeat(32769) },
    { ...body(), maxOutputTokens: 0 },
    { ...body(), maxInputTokens: 1 },
  ]) {
    assert.equal(parseProviderJobSubmission(invalid), null);
  }
});

test("shared admin cookie, wrong origin and non-admin role cannot submit", async () => {
  let forwarded = 0;
  const fetcher = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/editor/me")) {
      return Response.json({ username: "ci_editor", role: "editor" });
    }
    forwarded++;
    throw Error("should not forward");
  }) as typeof fetch;
  assert.equal((await dormantProviderJobSubmissionProxy(request(), null, fetcher)).status, 404);
  assert.equal(
    (await dormantProviderJobSubmissionProxy(request(body(), "https://evil.invalid"), CONFIG, fetcher)).status,
    403,
  );
  assert.equal(
    (
      await dormantProviderJobSubmissionProxy(
        request(body(), ORIGIN, "__Host-vns_session=" + "b".repeat(64)),
        CONFIG,
        fetcher,
      )
    ).status,
    401,
  );
  assert.equal((await dormantProviderJobSubmissionProxy(request(), CONFIG, fetcher)).status, 403);
  assert.equal(forwarded, 0);
});

test("named session forwards exact pending job and returns bounded sanitized receipt", async () => {
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/editor/me")) {
      return Response.json({ username: "ci_admin", role: "admin" });
    }
    assert.equal(String(url), CONFIG.api + "/admin/ai-provider-jobs");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Cookie"), COOKIE);
    assert.equal(new Headers(init?.headers).get("Origin"), ORIGIN);
    assert.deepEqual(JSON.parse(String(init?.body)), body());
    return Response.json({ accepted: true, active: false, enqueued: false, jobId: JOB }, { status: 202 });
  }) as typeof fetch;
  const response = await dormantProviderJobSubmissionProxy(request(), CONFIG, fetcher);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    accepted: true,
    enqueued: false,
    active: false,
    jobId: JOB,
  });
});

test("invalid upstream receipt, redirect, oversized and corrupt body fail closed", async () => {
  for (const upstream of [
    Response.json({ accepted: true, enqueued: true, active: false, jobId: JOB }, { status: 202 }),
    Response.json({ accepted: true, enqueued: false, active: false, jobId: "not-uuid" }, { status: 202 }),
    new Response("postgres-private-password", { status: 503 }),
    new Response("redirect", { status: 302, headers: { location: "https://evil.invalid" } }),
  ]) {
    const fetcher = (async (url: RequestInfo | URL) =>
      String(url).endsWith("/editor/me")
        ? Response.json({ username: "ci_admin", role: "admin" })
        : upstream) as typeof fetch;
    const response = await dormantProviderJobSubmissionProxy(request(), CONFIG, fetcher);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("postgres-private-password"), false);
  }
  let forwarded = 0;
  const fetcher = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/editor/me")) {
      return Response.json({ username: "ci_admin", role: "admin" });
    }
    forwarded++;
    throw Error("should not forward");
  }) as typeof fetch;
  assert.equal(
    (await dormantProviderJobSubmissionProxy(request({ ...body(), enable: true }), CONFIG, fetcher)).status,
    400,
  );
  assert.equal(
    (await dormantProviderJobSubmissionProxy(request({ ...body(), prompt: "x".repeat(32769) }), CONFIG, fetcher)).status,
    400,
  );
  assert.equal(forwarded, 0);
});
