import assert from "node:assert/strict";
import test from "node:test";
import {
  adminMutation,
  adminProxyConfig,
  clientAdminCookie,
  isAdminAuthorized,
  safeApiSetCookie,
} from "./admin-proxy";

const ORIGIN = "https://studio.example.invalid";
const CONFIG = { origin: ORIGIN, api: "http://api:4000" };
const TOKEN = "c".repeat(64);
const COOKIE = "__Host-vns_session=" + TOKEN;
const COOKIE_SET =
  COOKIE + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900";
const COOKIE_CLEAR =
  "__Host-vns_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";

function request(action: "login" | "logout", origin = ORIGIN, password = "password") {
  return new Request(ORIGIN + "/api/admin/" + action, {
    method: "POST",
    headers: {
      Origin: origin,
      ...(action === "login"
        ? { "Content-Type": "application/json" }
        : { Cookie: COOKIE }),
    },
    ...(action === "login" ? { body: JSON.stringify({ password }) } : {}),
  });
}

test("admin proxy remains disabled without explicit exact HTTPS configuration", () => {
  assert.equal(adminProxyConfig({}), null);
  assert.equal(adminProxyConfig({ VNS_WEB_ADMIN_ENABLED: "false" }), null);
  assert.equal(adminProxyConfig({ VNS_WEB_ADMIN_ENABLED: "yes" }), null);
  const good = {
    VNS_WEB_ADMIN_ENABLED: "true",
    VNS_ADMIN_ORIGIN: ORIGIN,
    VNS_API_INTERNAL_URL: CONFIG.api,
  };
  assert.deepEqual(adminProxyConfig(good), CONFIG);
  for (const override of [
    { VNS_ADMIN_ORIGIN: "http://studio.example.invalid" },
    { VNS_ADMIN_ORIGIN: ORIGIN + "/login" },
    { VNS_API_INTERNAL_URL: "https://example.com" },
    { VNS_API_INTERNAL_URL: "http://evil.example:4000" },
    { VNS_API_INTERNAL_URL: "http://api:4000/admin" },
    { VNS_API_INTERNAL_URL: "http://api:5000" },
  ]) {
    assert.equal(adminProxyConfig({ ...good, ...override }), null);
  }
});

test("session cookies are strict, unique and cannot be smuggled", () => {
  assert.equal(clientAdminCookie("other=1; " + COOKIE), COOKIE);
  assert.equal(clientAdminCookie(COOKIE + "; " + COOKIE), null);
  assert.equal(clientAdminCookie("__Host-vns_session=not-a-token"), null);
  assert.equal(clientAdminCookie(null), null);
  assert.equal(safeApiSetCookie(COOKIE_SET, "login"), COOKIE_SET);
  assert.equal(safeApiSetCookie(COOKIE_CLEAR, "logout"), COOKIE_CLEAR);
  assert.equal(safeApiSetCookie(COOKIE_SET, "logout"), null);
  assert.equal(safeApiSetCookie(COOKIE_CLEAR, "login"), null);
  assert.equal(safeApiSetCookie("session=" + TOKEN + "; HttpOnly", "login"), null);
  assert.equal(safeApiSetCookie(COOKIE_SET + ", session=hijack", "login"), null);
});

test("web login refuses disabled mode and CSRF before contacting API", async () => {
  let calls = 0;
  const fake: typeof fetch = async () => {
    calls += 1;
    return new Response();
  };
  assert.equal((await adminMutation(request("login"), "login", null, fake)).status, 404);
  assert.equal(
    (await adminMutation(request("login", "https://attacker.example"), "login", CONFIG, fake))
      .status,
    403,
  );
  assert.equal(calls, 0);
});

test("web proxy forwards only password to internal API and only validated secure cookie back", async () => {
  let calls = 0;
  const fake: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(input, "http://api:4000/auth/login");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("origin"), ORIGIN);
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "manual");
    assert.deepEqual(JSON.parse(init?.body as string), { password: "password" });
    return new Response(JSON.stringify({ secret: TOKEN }), {
      status: 200,
      headers: { "Set-Cookie": COOKIE_SET },
    });
  };
  const response = await adminMutation(request("login"), "login", CONFIG, fake);
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), COOKIE_SET);
  assert.deepEqual(await response.json(), { authenticated: true });
  assert.ok(!(await response.clone().text()).includes(TOKEN));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("malformed requests, spoofed upstream cookies and API errors fail closed", async () => {
  const invalid = new Request(ORIGIN + "/api/admin/login", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
    body: "password=secret",
  });
  assert.equal((await adminMutation(invalid, "login", CONFIG)).status, 400);
  const tooLarge = request("login", ORIGIN, "x".repeat(2200));
  assert.equal((await adminMutation(tooLarge, "login", CONFIG)).status, 400);

  const badCookie: typeof fetch = async () =>
    new Response("ok", { status: 200, headers: { "Set-Cookie": "session=hijack" } });
  const bad = await adminMutation(request("login"), "login", CONFIG, badCookie);
  assert.equal(bad.status, 503);
  assert.equal(bad.headers.get("set-cookie"), null);

  const down: typeof fetch = async () => {
    throw new Error("connection refused");
  };
  assert.equal((await adminMutation(request("login"), "login", CONFIG, down)).status, 503);

  const blocked: typeof fetch = async () => new Response("", { status: 429 });
  assert.equal((await adminMutation(request("login"), "login", CONFIG, blocked)).status, 429);
  const denied: typeof fetch = async () => new Response("", { status: 401 });
  assert.equal((await adminMutation(request("login"), "login", CONFIG, denied)).status, 401);
});

test("logout checks origin, forwards only session cookie, and invalidates browser cookie", async () => {
  const csrf = await adminMutation(
    request("logout", "https://attacker.example"),
    "logout",
    CONFIG,
  );
  assert.equal(csrf.status, 403);

  const fake: typeof fetch = async (input, init) => {
    assert.equal(input, "http://api:4000/auth/logout");
    assert.equal(new Headers(init?.headers).get("cookie"), COOKIE);
    assert.equal(new Headers(init?.headers).get("origin"), ORIGIN);
    return new Response("ok", { status: 200, headers: { "Set-Cookie": COOKIE_CLEAR } });
  };
  const response = await adminMutation(request("logout"), "logout", CONFIG, fake);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), COOKIE_CLEAR);
  assert.deepEqual(await response.json(), { authenticated: false });

  const missing = new Request(ORIGIN + "/api/admin/logout", {
    method: "POST",
    headers: { Origin: ORIGIN },
  });
  assert.equal((await adminMutation(missing, "logout", CONFIG, fake)).status, 401);
});

test("server-rendered admin view fails closed when session is absent, forged, expired or offline", async () => {
  const ok: typeof fetch = async (input, init) => {
    assert.equal(input, "http://api:4000/admin/me");
    assert.equal(new Headers(init?.headers).get("cookie"), COOKIE);
    return Response.json({ role: "admin" });
  };
  assert.equal(await isAdminAuthorized(CONFIG, null, ok), false);
  assert.equal(await isAdminAuthorized(null, COOKIE, ok), false);
  assert.equal(await isAdminAuthorized(CONFIG, "other=" + TOKEN, ok), false);
  assert.equal(await isAdminAuthorized(CONFIG, COOKIE, ok), true);

  const unauth: typeof fetch = async () => new Response("unauthorized", { status: 401 });
  assert.equal(await isAdminAuthorized(CONFIG, COOKIE, unauth), false);
  const impersonation: typeof fetch = async () => Response.json({ role: "viewer" });
  assert.equal(await isAdminAuthorized(CONFIG, COOKIE, impersonation), false);
  const down: typeof fetch = async () => {
    throw new Error("offline");
  };
  assert.equal(await isAdminAuthorized(CONFIG, COOKIE, down), false);
});
