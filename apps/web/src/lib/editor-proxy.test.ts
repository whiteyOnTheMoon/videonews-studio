import assert from "node:assert/strict";
import test from "node:test";
import {
  clientEditorCookie, editorMutation, editorProfile, editorProxyConfig,
} from "./editor-proxy";
import { submitEditorEvidenceReview } from "./admin-evidence-proxy";

const CONFIG = { origin: "https://studio.example.invalid", api: "http://api:4000" };
const RAW = "__Host-vns_editor=" + "e".repeat(64);
const SET_COOKIE = RAW + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900";
const CLEAR_COOKIE = "__Host-vns_editor=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
const ID = "12345678-1234-4123-8123-123456789012";
const REASON = "The underlying report does not establish the full proposed claim.";

const request = (path: string, body: unknown, headers: Record<string,string> = {}) =>
  new Request(CONFIG.origin + path, {
    method: "POST",
    headers: { Origin: CONFIG.origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("personal editor BFF remains disabled unless all web/admin gates enabled", () => {
  assert.equal(editorProxyConfig({}), null);
  assert.equal(editorProxyConfig({ VNS_WEB_EDITOR_AUTH_ENABLED: "true" }), null);
  assert.deepEqual(editorProxyConfig({
    VNS_WEB_ADMIN_ENABLED: "true",
    VNS_WEB_ADMIN_JOBS_ENABLED: "true",
    VNS_WEB_EDITOR_AUTH_ENABLED: "true",
    VNS_ADMIN_ORIGIN: CONFIG.origin,
    VNS_API_INTERNAL_URL: CONFIG.api,
  }), CONFIG);
});

test("editor cookie parser rejects duplicates and forged cookie attributes", () => {
  assert.equal(clientEditorCookie(RAW), RAW);
  assert.equal(clientEditorCookie(RAW + "; foo=bar"), RAW);
  assert.equal(clientEditorCookie(RAW + "; " + RAW), null);
  assert.equal(clientEditorCookie("__Host-vns_session=" + "f".repeat(64)), null);
  assert.equal(clientEditorCookie("__Host-vns_editor=invalid"), null);
});

test("login validates exact username/password, forwards no secrets to response", async () => {
  let count = 0;
  const fake: typeof fetch = async (url, init) => {
    count += 1;
    assert.equal(url, CONFIG.api + "/editor/auth/login");
    assert.deepEqual(JSON.parse(init?.body as string), {
      username: "ci_reviewer", password: "test-personal-password",
    });
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    return new Response(JSON.stringify({ authenticated: true, private: "hidden" }), {
      headers: { "Set-Cookie": SET_COOKIE },
    });
  };
  const valid = request("/api/editor/login", {
    username: "ci_reviewer", password: "test-personal-password",
  });
  assert.equal((await editorMutation(valid, "login", null, fake)).status, 404);
  assert.equal((await editorMutation(request("/api/editor/login", {
    username: "ci_reviewer", password: "test-personal-password",
  }, { Origin: "https://forged.invalid" }), "login", CONFIG, fake)).status, 403);
  assert.equal((await editorMutation(request("/api/editor/login", {
    username: "bad username", password: "test-personal-password",
  }), "login", CONFIG, fake)).status, 400);
  assert.equal((await editorMutation(request("/api/editor/login", {
    username: "ci_reviewer", password: "short",
  }), "login", CONFIG, fake)).status, 400);
  assert.equal(count, 0);
  const result = await editorMutation(request("/api/editor/login", {
    username: "ci_reviewer", password: "test-personal-password",
  }), "login", CONFIG, fake);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("set-cookie"), SET_COOKIE);
  assert.deepEqual(await result.json(), { authenticated: true });
  assert.equal(count, 1);
});

test("logout requires personal cookie; upstream Set-Cookie is strictly checked", async () => {
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, CONFIG.api + "/editor/auth/logout");
    assert.equal(new Headers(init?.headers).get("cookie"), RAW);
    return new Response(null, { headers: { "Set-Cookie": CLEAR_COOKIE } });
  };
  assert.equal((await editorMutation(request("/api/editor/logout", {}, { Cookie: "__Host-vns_session=invalid" }), "logout", CONFIG, fake)).status, 401);
  const result = await editorMutation(request("/api/editor/logout", {}, { Cookie: RAW }), "logout", CONFIG, fake);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("set-cookie"), CLEAR_COOKIE);
  const forged: typeof fetch = async () => new Response(null, {
    headers: { "Set-Cookie": SET_COOKIE + "; Domain=evil.invalid" },
  });
  assert.equal((await editorMutation(request("/api/editor/login", {
    username: "ci_reviewer", password: "test-personal-password",
  }), "login", CONFIG, forged)).status, 503);
});

test("profile proxy requires valid personal token and filters upstream details", async () => {
  const fake: typeof fetch = async (url, init) => {
    assert.equal(url, CONFIG.api + "/editor/me");
    assert.equal(new Headers(init?.headers).get("cookie"), RAW);
    return Response.json({ username: "ci_reviewer", role: "reviewer", secret: "not-forwarded" });
  };
  assert.equal((await editorProfile(new Request(CONFIG.origin + "/api/editor/me"), CONFIG, fake)).status, 401);
  assert.equal((await editorProfile(new Request(CONFIG.origin + "/api/editor/me", { headers: { Cookie: RAW } }), CONFIG, fake)).status, 503);
  const correct: typeof fetch = async () => Response.json({ username: "ci_reviewer", role: "reviewer" });
  const valid = await editorProfile(new Request(CONFIG.origin + "/api/editor/me", { headers: { Cookie: RAW } }), CONFIG, correct);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { username: "ci_reviewer", role: "reviewer" });
});

test("personal evidence review never accepts only shared admin cookie", async () => {
  let sent = 0;
  const mock: typeof fetch = async (url, init) => {
    sent += 1;
    assert.equal(url, CONFIG.api + "/editor/evidence/review");
    assert.equal(new Headers(init?.headers).get("cookie"), RAW);
    assert.equal(new Headers(init?.headers).get("origin"), CONFIG.origin);
    return Response.json({ reviewed: true });
  };
  const body = { evidenceId: ID, decision: "disputed", reason: REASON };
  assert.equal((await submitEditorEvidenceReview(request("/api/admin/evidence/review", body, {
    Cookie: "__Host-vns_session=" + "f".repeat(64),
  }), CONFIG, mock)).status, 401);
  assert.equal(sent, 0);
  const result = await submitEditorEvidenceReview(request("/api/admin/evidence/review", body, { Cookie: RAW }), CONFIG, mock);
  assert.equal(result.status, 200);
  assert.equal(sent, 1);
  assert.deepEqual(await result.json(), { reviewed: true });
});
