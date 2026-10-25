import assert from "node:assert/strict";
import test from "node:test";
import {
  dormantAdminAiProviderWriteProxy,
  parseAdminAiProviderMutation,
} from "./admin-ai-provider-write-contract";

const COOKIE = "__Host-vns_editor=" + "a".repeat(64);
const SHARED_COOKIE = "__Host-vns_session=" + "b".repeat(64);
const ORIGIN = "https://studio.ap-pixels.com";
const CFG = { origin: ORIGIN, api: "http://api:4000" };
const FAKE_KEY = "sk-synthetic-fixture-never-a-real-credential-000001";
const COMMAND = { provider: "openai", action: "set_key", apiKey: FAKE_KEY };

function req(
  value: unknown = COMMAND,
  options: { method?: string; origin?: string; cookie?: string; contentType?: string } = {},
): Request {
  const method = options.method ?? "POST";
  return new Request(ORIGIN + "/api/admin/ai-providers", {
    method,
    headers: {
      Origin: options.origin ?? ORIGIN,
      Cookie: options.cookie ?? COOKIE,
      "Content-Type": options.contentType ?? "application/json",
    },
    ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(value) }),
  });
}

function assertSanitized(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}

test("strict command allowlist blocks extra data, arbitrary URLs and provider activation", () => {
  const valid = [
    { action: "set_key", provider: "openai", apiKey: FAKE_KEY },
    { action: "set_key", provider: "google_gemini", apiKey: FAKE_KEY },
    { action: "remove_key", provider: "openai" },
    { action: "set_model", provider: "openai", model: "gpt-6-luna" },
    { action: "set_model", provider: "google_gemini", model: "gemini-3.8-flash-tts" },
  ];
  for (const candidate of valid) {
    assert.deepEqual(parseAdminAiProviderMutation(candidate), candidate);
  }
  for (const candidate of [
    null,
    [],
    {},
    { ...COMMAND, apiKey: "short" },
    { ...COMMAND, apiKey: FAKE_KEY + "\n" },
    { ...COMMAND, apiKey: FAKE_KEY + "\u0000" },
    { ...COMMAND, apiKey: "x".repeat(513) },
    { ...COMMAND, password: "synthetic-unknown-field" },
    { ...COMMAND, provider: "other" },
    { ...COMMAND, provider: "__proto__" },
    { ...COMMAND, endpoint: "https://external.invalid" },
    { action: "enable", provider: "openai" },
    { action: "test_connection", provider: "openai" },
    { action: "remove_key", provider: "openai", apiKey: FAKE_KEY },
    { action: "remove_key", provider: "unknown" },
    { action: "set_model", provider: "openai", model: "unknown" },
    { action: "set_model", provider: "openai", model: "https://external.invalid" },
    { action: "set_model", provider: "openai", model: "gemini-3.8-flash-tts" },
    { action: "set_model", provider: "google_gemini", model: "gpt-6.1-sol" },
    { action: "set_model", provider: "openai", model: "gpt-6-luna", apiKey: FAKE_KEY },
  ]) {
    assert.equal(parseAdminAiProviderMutation(candidate), null);
  }
});

test("disabled configuration denies mutation before authentication or any network call", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    throw new Error("Unexpected network");
  }) as typeof fetch;
  const denied = await dormantAdminAiProviderWriteProxy(req(), null, fetcher);
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "not_found" });
  assertSanitized(denied);
  assert.equal(called, false);
});

test("GET, wrong origin and malformed cookies never touch internal API", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    throw new Error("Unexpected upstream");
  }) as typeof fetch;
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
    const response = await dormantAdminAiProviderWriteProxy(
      req(undefined, { method }),
      CFG,
      fetcher,
    );
    assert.equal(response.status, 405);
    assertSanitized(response);
  }
  for (const origin of ["https://evil.invalid", "", "http://studio.ap-pixels.com"]) {
    const response = await dormantAdminAiProviderWriteProxy(req(COMMAND, { origin }), CFG, fetcher);
    assert.equal(response.status, 403);
  }
  for (const cookie of ["invalid", "", COOKIE + "; " + COOKIE]) {
    const response = await dormantAdminAiProviderWriteProxy(req(COMMAND, { cookie }), CFG, fetcher);
    assert.equal(response.status, 401);
  }
  assert.equal(called, false);
});

test("non-admin personal session cannot authorize provider changes", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (String(input).endsWith("/editor/me")) {
      return Response.json({ role: "editor", username: "ci_editor" });
    }
    throw new Error("Must not submit provider key");
  }) as typeof fetch;
  const response = await dormantAdminAiProviderWriteProxy(req(), CFG, fetcher);
  assert.equal(response.status, 403);
  assert.deepEqual(calls, [CFG.api + "/editor/me"]);
});

test("canonical command with fake key is forwarded ONLY after admin check", async () => {
  const visited: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    visited.push(url);
    assert.equal(new Headers(init?.headers).get("Cookie"), COOKIE);
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "manual");
    if (url.endsWith("/editor/me")) {
      return Response.json({ role: "admin", username: "ci_admin" });
    }
    assert.equal(url, CFG.api + "/admin/ai-providers");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Origin"), ORIGIN);
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(init?.body)), COMMAND);
    return Response.json({ saved: true, active: false });
  }) as typeof fetch;
  const result = await dormantAdminAiProviderWriteProxy(req(), CFG, fetcher);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { saved: true, active: false });
  assertSanitized(result);
  assert.deepEqual(visited, [CFG.api + "/editor/me", CFG.api + "/admin/ai-providers"]);
});

test("invalid payloads, body formats and over-limit inputs never reach write endpoint", async () => {
  let writes = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/editor/me")) {
      return Response.json({ role: "admin", username: "ci_admin" });
    }
    writes++;
    throw new Error("Unexpected write");
  }) as typeof fetch;
  for (const value of [
    { action: "enable", provider: "openai" },
    { action: "set_key", provider: "openai", apiKey: "short" },
    { action: "set_key", provider: "openai", apiKey: FAKE_KEY, extra: true },
    { action: "set_model", provider: "openai", model: "google" },
    {},
    null,
  ]) {
    const result = await dormantAdminAiProviderWriteProxy(req(value), CFG, fetcher);
    assert.equal(result.status, 400);
  }
  const oversized = await dormantAdminAiProviderWriteProxy(
    req({ ...COMMAND, junk: "X".repeat(2000) }),
    CFG,
    fetcher,
  );
  assert.equal(oversized.status, 400);
  const type = await dormantAdminAiProviderWriteProxy(
    req(COMMAND, { contentType: "text/plain" }),
    CFG,
    fetcher,
  );
  assert.equal(type.status, 400);
  assert.equal(writes, 0);
});

test("error or unexpected response does not echo credentials or upstream text", async () => {
  const responses: Response[] = [
    new Response("secret-provider-key=" + FAKE_KEY, { status: 500 }),
    new Response("redirect", { status: 302, headers: { location: "https://evil.invalid" } }),
    Response.json({ saved: true, active: true }),
    Response.json({ saved: true, active: false, apiKey: FAKE_KEY }),
    Response.json({ success: true }),
    new Response("not-json-" + FAKE_KEY, { status: 200 }),
    new Response("x".repeat(1024), { status: 200 }),
  ];
  for (const upstream of responses) {
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/editor/me")) {
      return Response.json({ role: "admin", username: "ci_admin" });
    }
      return upstream;
    }) as typeof fetch;
    const response = await dormantAdminAiProviderWriteProxy(req(), CFG, fetcher);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(!body.includes(FAKE_KEY));
    assert.ok(!body.includes("secret-provider"));
    assertSanitized(response);
  }
});

test("backend rejections map to generic status with no raw secret data", async () => {
  for (const [upstream, expected] of [
    [401, 401],
    [403, 403],
    [400, 400],
    [429, 429],
  ] as const) {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/editor/me")
        ? Response.json({ role: "admin", username: "ci_admin" })
        : new Response(FAKE_KEY, { status: upstream })) as typeof fetch;
    const response = await dormantAdminAiProviderWriteProxy(req(), CFG, fetcher);
    assert.equal(response.status, expected);
    assert.ok(!(await response.text()).includes(FAKE_KEY));
  }
});

test("shared admin token is never used as provider write identity", async () => {
  let upstreamCalls = 0;
  const fetcher = (async () => {
    upstreamCalls++;
    return Response.json({ role: "admin", username: "ci_admin" });
  }) as typeof fetch;
  const sharedOnly = await dormantAdminAiProviderWriteProxy(
    req(COMMAND, { cookie: SHARED_COOKIE }),
    CFG,
    fetcher,
  );
  assert.equal(sharedOnly.status, 401);
  assert.equal(upstreamCalls, 0);
});

test("personal editor profile must pass exact validation before forwarding", async () => {
  const values: Array<unknown> = [
    { role: "admin" },
    { role: "admin", username: "not valid" },
    { role: "reviewer", username: "ci_editor" },
    { role: "admin", username: "ci_admin", apiKey: FAKE_KEY },
  ];
  for (const value of values) {
    let writes = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/editor/me")) return Response.json(value);
      writes++;
      return Response.json({ saved: true, active: false });
    }) as typeof fetch;
    const result = await dormantAdminAiProviderWriteProxy(req(), CFG, fetcher);
    assert.notEqual(result.status, 200);
    assert.equal(writes, 0);
  }
});

test("invalid JSON framing and encoding are rejected before upstream writes", async () => {
  let writes = 0;
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/editor/me")) {
      return Response.json({ role: "admin", username: "ci_admin" });
    }
    writes++;
    return Response.json({ saved: true, active: false });
  }) as typeof fetch;
  for (const header of [
    { "Content-Length": "1" },
    { "Content-Length": "999" },
    { "Content-Length": "0001" },
    { "Content-Length": "1025" },
    { "Content-Encoding": "gzip" },
  ]) {
    const headers = new Headers({
      Origin: ORIGIN,
      Cookie: COOKIE,
      "Content-Type": "application/json",
    });
    for (const [name, value] of Object.entries(header)) {
      headers.set(name, value);
    }
    const request = new Request(ORIGIN + "/api/admin/ai-providers", {
      method: "POST",
      headers,
      body: JSON.stringify(COMMAND),
    });
    const result = await dormantAdminAiProviderWriteProxy(request, CFG, fetcher);
    assert.equal(result.status, 400);
  }
  assert.equal(writes, 0);
});

