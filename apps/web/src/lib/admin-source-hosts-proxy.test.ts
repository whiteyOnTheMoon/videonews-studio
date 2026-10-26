import assert from "node:assert/strict";
import test from "node:test";
import {
  dormantHostApprovalProxy,
  hostApprovalProxyConfig,
  parseHostApprovalCommand,
  parseHostApprovalView,
} from "./admin-source-hosts-proxy";

const ORIGIN = "https://studio.ap-pixels.com";
const COOKIE = "__Host-vns_editor=" + "a".repeat(64);
const config = { origin: ORIGIN, api: "http://api:4000" };
const change = {
  action: "grant",
  expectedRevision: 0,
  expectedSourceRevision: 2,
  host: "news.example.org",
  reason: "Reviewed the synthetic source terms for limited metadata use.",
};
function request(method: string, body: unknown = change, cookie = COOKIE, origin = ORIGIN) {
  return new Request(ORIGIN + "/api/admin/source-hosts", {
    method,
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}
test("host BFF requires two independent default-off flags and personal auth configuration", () => {
  const env = {
    VNS_WEB_ADMIN_ENABLED: "true",
    VNS_WEB_EDITOR_AUTH_ENABLED: "true",
    VNS_WEB_ADMIN_JOBS_ENABLED: "true",
    VNS_ADMIN_ORIGIN: ORIGIN,
    VNS_API_INTERNAL_URL: config.api,
    VNS_WEB_SOURCE_REGISTRY_ENABLED: "true",
  };
  assert.equal(hostApprovalProxyConfig(env), null);
  assert.deepEqual(hostApprovalProxyConfig({
    ...env,
    VNS_WEB_HOST_APPROVAL_ENABLED: "true",
  }), config);
  assert.equal(hostApprovalProxyConfig({
    ...env,
    VNS_WEB_EDITOR_AUTH_ENABLED: "false",
    VNS_WEB_HOST_APPROVAL_ENABLED: "true",
  }), null);
  assert.equal(hostApprovalProxyConfig({
    ...env,
    VNS_WEB_SOURCE_REGISTRY_ENABLED: "false",
    VNS_WEB_HOST_APPROVAL_ENABLED: "true",
  }), null);
});
test("commands and snapshots reject forged identity and host grants", () => {
  assert.deepEqual(parseHostApprovalCommand(change), change);
  assert.deepEqual(parseHostApprovalView({
    revision: 2, approvedHosts: ["news.example.org"], feedActive: false,
  }), {
    revision: 2, approvedHosts: ["news.example.org"], feedActive: false,
  });
  for (const invalid of [
    { ...change, editorId: "forged" },
    { ...change, allowedHosts: ["other.example.org"] },
    { ...change, feedActive: true },
    { ...change, reason: "too short" },
    { ...change, expectedSourceRevision: 0 },
    { ...change, host: "127.0.0.1" },
    { ...change, host: "xn--unsafe.example.org" },
    { ...change, action: "activate" },
  ]) assert.equal(parseHostApprovalCommand(invalid), null);
  for (const value of [
    { revision: 2, approvedHosts: ["news.example.org"], feedActive: true },
    { revision: 2, approvedHosts: ["news.example.org"], feedActive: false, apiKey: "secret" },
    { revision: 2, approvedHosts: ["news.example.org", "news.example.org"], feedActive: false },
    { revision: 2, approvedHosts: ["other.example.org", "news.example.org"], feedActive: false },
    { revision: -1, approvedHosts: [], feedActive: false },
  ]) assert.equal(parseHostApprovalView(value), null);
});
test("disabled, foreign Origin and shared admin cookie fail before upstream", async () => {
  let calls = 0;
  const blocked = (async () => { calls++; throw new Error("upstream should not run"); }) as typeof fetch;
  assert.equal((await dormantHostApprovalProxy(request("POST"), null, blocked)).status, 404);
  assert.equal((await dormantHostApprovalProxy(request("PUT"), config, blocked)).status, 405);
  assert.equal((await dormantHostApprovalProxy(request("POST", change, COOKIE, "https://evil.example.org"), config, blocked)).status, 403);
  assert.equal((await dormantHostApprovalProxy(request("POST", change, "__Host-vns_session=" + "a".repeat(64)), config, blocked)).status, 401);
  assert.equal(calls, 0);
});
test("editor role never reaches host approval API", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({ username: "ci_editor", role: "editor" });
  }) as typeof fetch;
  assert.equal((await dormantHostApprovalProxy(request("POST"), config, fetcher)).status, 403);
  assert.equal(calls, 1);
});
test("authorized GET and POST forward only personal cookie, sanitized payload and no activations", async () => {
  const endpoints: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    endpoints.push(url);
    assert.equal(new Headers(init?.headers).get("cookie"), COOKIE);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "manual");
    if (url.endsWith("/editor/me")) return Response.json({ username: "ci_admin", role: "admin" });
    assert.equal(url, config.api + "/admin/source-hosts");
    if (init?.method === "GET") return Response.json({
      revision: 0, approvedHosts: [], feedActive: false,
    });
    assert.equal(new Headers(init?.headers).get("origin"), ORIGIN);
    assert.deepEqual(JSON.parse(String(init?.body)), change);
    return Response.json({
      saved: true, host: change.host, action: change.action, revision: 1, feedActive: false,
    });
  }) as typeof fetch;
  assert.deepEqual(await (await dormantHostApprovalProxy(request("GET"), config, fetcher)).json(), {
    revision: 0, approvedHosts: [], feedActive: false,
  });
  const result = await dormantHostApprovalProxy(request("POST"), config, fetcher);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), {
    saved: true, host: change.host, action: change.action, revision: 1, feedActive: false,
  });
  assert.deepEqual(endpoints, [
    config.api + "/editor/me", config.api + "/admin/source-hosts",
    config.api + "/editor/me", config.api + "/admin/source-hosts",
  ]);
});
test("upstream redirects, secrets and dishonest write acknowledgements fail closed", async () => {
  for (const upstream of [
    Response.json({ saved: true, host: change.host, action: change.action, revision: 1, feedActive: true }),
    Response.json({ saved: true, host: change.host, action: change.action, revision: 1, feedActive: false, secret: "opaque" }),
    Response.json({ saved: true, host: change.host, action: change.action, revision: 17, feedActive: false }),
    new Response(null, { status: 302, headers: { location: "https://other.example.org/" } }),
    new Response("internal database secrets", { status: 500 }),
  ]) {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/editor/me")
        ? Response.json({ username: "ci_admin", role: "admin" })
        : upstream) as typeof fetch;
    const response = await dormantHostApprovalProxy(request("POST"), config, fetcher);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("secret"));
  }
});
