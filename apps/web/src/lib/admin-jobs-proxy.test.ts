import assert from "node:assert/strict";
import test from "node:test";
import { adminJobsProxyConfig, adminResearchJobProxy } from "./admin-jobs-proxy";

const ORIGIN = "https://studio.example.invalid";
const CONFIG = { origin: ORIGIN, api: "http://api:4000" };
const COOKIE = "__Host-vns_session=" + "d".repeat(64);
const KEY = "ci_research_job_idempotency_001";
const ID = "e8acf570-a11e-4bb9-9139-498abc493b18";

function request(input: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + "/api/admin/jobs", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      Cookie: COOKIE,
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof input === "string" ? input : JSON.stringify(input),
  });
}

test("job proxy is off by default, including in existing admin preview", () => {
  assert.equal(adminJobsProxyConfig({}), null);
  assert.equal(
    adminJobsProxyConfig({
      VNS_WEB_ADMIN_ENABLED: "true",
      VNS_ADMIN_ORIGIN: ORIGIN,
      VNS_API_INTERNAL_URL: CONFIG.api,
    }),
    null,
  );
  assert.deepEqual(
    adminJobsProxyConfig({
      VNS_WEB_ADMIN_JOBS_ENABLED: "true",
      VNS_WEB_ADMIN_ENABLED: "true",
      VNS_ADMIN_ORIGIN: ORIGIN,
      VNS_API_INTERNAL_URL: CONFIG.api,
    }),
    CONFIG,
  );
});

test("job proxy rejects anonymous cookies, cross-origin requests and bad payloads", async () => {
  let calls = 0;
  const upstream: typeof fetch = async () => {
    calls += 1;
    return Response.json({ accepted: true, jobId: ID }, { status: 202 });
  };
  const valid = { kind: "research", idempotencyKey: KEY };
  assert.equal((await adminResearchJobProxy(request(valid), null, upstream)).status, 404);
  assert.equal(
    (
      await adminResearchJobProxy(
        request(valid, { Origin: "https://evil.invalid" }),
        CONFIG,
        upstream,
      )
    ).status,
    403,
  );
  assert.equal(
    (await adminResearchJobProxy(request(valid, { Cookie: "session=forged" }), CONFIG, upstream))
      .status,
    401,
  );
  assert.equal(
    (
      await adminResearchJobProxy(
        request({ kind: "render", idempotencyKey: KEY }),
        CONFIG,
        upstream,
      )
    ).status,
    400,
  );
  assert.equal(
    (await adminResearchJobProxy(request({ ...valid, extra: "secret" }), CONFIG, upstream)).status,
    400,
  );
  assert.equal(
    (
      await adminResearchJobProxy(
        request(valid, { "Content-Type": "text/plain" }),
        CONFIG,
        upstream,
      )
    ).status,
    400,
  );
  assert.equal(
    (await adminResearchJobProxy(request("x".repeat(2000)), CONFIG, upstream)).status,
    400,
  );
  assert.equal(calls, 0);
});

test("job proxy forwards only allowlisted payload, cookie and HTTPS Origin", async () => {
  let calls = 0;
  const upstream: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(input, CONFIG.api + "/admin/jobs");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("origin"), ORIGIN);
    assert.equal(headers.get("cookie"), COOKIE);
    assert.equal(headers.get("authorization"), null);
    assert.deepEqual(JSON.parse(init?.body as string), { kind: "research", idempotencyKey: KEY });
    return Response.json({ accepted: true, jobId: ID, private: "hidden" }, { status: 202 });
  };
  const response = await adminResearchJobProxy(
    request({
      kind: "research",
      idempotencyKey: KEY,
    }),
    CONFIG,
    upstream,
  );
  assert.equal(calls, 1);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { accepted: true, jobId: ID });
});

test("job proxy sanitizes upstream unavailability, redirects, and invalid responses", async () => {
  const valid = request({ kind: "research", idempotencyKey: KEY });
  const invalid: typeof fetch = async () =>
    Response.json({ accepted: true, jobId: "bad" }, { status: 202 });
  assert.equal((await adminResearchJobProxy(valid, CONFIG, invalid)).status, 503);
  const down: typeof fetch = async () => {
    throw new Error("secret internal host");
  };
  assert.equal(
    (await adminResearchJobProxy(request({ kind: "research", idempotencyKey: KEY }), CONFIG, down))
      .status,
    503,
  );
  const conflict: typeof fetch = async () =>
    Response.json({ error: "internal SQL" }, { status: 409 });
  const response = await adminResearchJobProxy(
    request({ kind: "research", idempotencyKey: KEY }),
    CONFIG,
    conflict,
  );
  assert.deepEqual(await response.json(), { error: "idempotency_conflict" });
});
