import assert from "node:assert/strict";
import test from "node:test";
import { adminResearchJobsList, isResearchJobOverview } from "./admin-jobs-list";

const ORIGIN = "https://studio.example.invalid";
const CONFIG = { origin: ORIGIN, api: "http://api:4000" };
const COOKIE = "__Host-vns_session=" + "e".repeat(64);
const JOB = {
  id: "e8acf570-a11e-4bb9-9139-498abc493b18",
  kind: "research",
  status: "pending",
  deliveryState: "pending",
  createdAt: "2026-10-23T18:00:00.000Z",
};

function request(cookie: string | null = COOKIE): Request {
  return new Request(ORIGIN + "/api/admin/jobs", {
    method: "GET",
    headers: cookie ? { Cookie: cookie } : {},
  });
}

test("list proxy is disabled without config and rejects anonymous or forged cookies", async () => {
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls += 1;
    return Response.json({ jobs: [] });
  };
  assert.equal((await adminResearchJobsList(request(), null, fake)).status, 404);
  assert.equal((await adminResearchJobsList(request(null), CONFIG, fake)).status, 401);
  assert.equal((await adminResearchJobsList(request("other=wrong"), CONFIG, fake)).status, 401);
  assert.equal(
    (await adminResearchJobsList(request(COOKIE + "; " + COOKIE), CONFIG, fake)).status,
    401,
  );
  assert.equal(calls, 0);
});

test("list proxy only relays authenticated narrow rows, never internal details", async () => {
  const fake: typeof fetch = async (input, init) => {
    assert.equal(input, "http://api:4000/admin/jobs");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("cookie"), COOKIE);
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    return Response.json({ jobs: [JOB], internal: "secret" });
  };
  const response = await adminResearchJobsList(request(), CONFIG, fake);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), { jobs: [JOB] });
  assert.equal(isResearchJobOverview(JOB), true);
  assert.equal(isResearchJobOverview({ ...JOB, privateSql: "secret" }), false);
  assert.equal(isResearchJobOverview({ ...JOB, createdAt: "not-a-date" }), false);
});

test("malformed, oversized, unauthorized and unavailable upstream lists fail closed", async () => {
  const oversized: typeof fetch = async () =>
    Response.json({ jobs: Array.from({ length: 21 }, () => JOB) });
  assert.equal((await adminResearchJobsList(request(), CONFIG, oversized)).status, 503);
  const invalid: typeof fetch = async () => Response.json({ jobs: [{ ...JOB, status: "secret" }] });
  assert.equal((await adminResearchJobsList(request(), CONFIG, invalid)).status, 503);
  const missing: typeof fetch = async () => new Response("unauthorized", { status: 401 });
  assert.equal((await adminResearchJobsList(request(), CONFIG, missing)).status, 401);
  const down: typeof fetch = async () => {
    throw new Error("private host/credentials");
  };
  const unavailable = await adminResearchJobsList(request(), CONFIG, down);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "temporarily_unavailable" });
  const redirect: typeof fetch = async () =>
    new Response("", {
      status: 302,
      headers: { Location: "https://outside.example.invalid" },
    });
  assert.equal((await adminResearchJobsList(request(), CONFIG, redirect)).status, 503);
});
