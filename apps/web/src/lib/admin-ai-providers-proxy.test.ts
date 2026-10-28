import assert from "node:assert/strict";
import test from "node:test";
import {
  aiProviderReadOnlyProxyConfig,
  readOnlyAdminAiProvidersProxy,
} from "./admin-ai-providers-proxy";
import { parseAdminAiProviders } from "./admin-ai-provider-view";

const COOKIE = "__Host-vns_editor=" + "a".repeat(64);
const SHARED_COOKIE = "__Host-vns_session=" + "b".repeat(64);
const CFG = { origin: "https://studio.ap-pixels.com", api: "http://api:4000" };

function req(method = "GET", cookie = COOKIE): Request {
  return new Request(CFG.origin + "/api/admin/ai-providers", {
    method,
    headers: { cookie },
  });
}
function payload(extra: Record<string, unknown> = {}) {
  return {
    providers: [
      {
        provider: "openai",
        selectedModel: "gpt-6.1-sol",
        configured: false,
        active: false,
        ...extra,
      },
      {
        provider: "google_gemini",
        selectedModel: "gemini-3.8-flash-tts",
        configured: false,
        active: false,
      },
    ],
  };
}

test("read-only feature defaults off, never enabled by normal admin flags", () => {
  const env = {
    VNS_WEB_ADMIN_ENABLED: "true",
    VNS_ADMIN_ORIGIN: CFG.origin,
    VNS_API_INTERNAL_URL: CFG.api,
    VNS_WEB_ADMIN_JOBS_ENABLED: "true",
    VNS_WEB_EDITOR_AUTH_ENABLED: "true",
  };
  assert.equal(aiProviderReadOnlyProxyConfig(env), null);
  assert.deepEqual(
    aiProviderReadOnlyProxyConfig({ ...env, VNS_WEB_AI_PROVIDER_READONLY_ENABLED: "true" }),
    CFG,
  );
  assert.equal(
    aiProviderReadOnlyProxyConfig({ ...env, VNS_WEB_AI_PROVIDER_READONLY_ENABLED: "false" }),
    null,
  );
  assert.equal(
    aiProviderReadOnlyProxyConfig({ ...env, VNS_WEB_EDITOR_AUTH_ENABLED: "false" }),
    null,
  );
  assert.equal(
    aiProviderReadOnlyProxyConfig({ ...env, VNS_WEB_ADMIN_JOBS_ENABLED: "false" }),
    null,
  );
  assert.equal(
    aiProviderReadOnlyProxyConfig({
      ...env,
      VNS_ADMIN_ORIGIN: "http://studio.ap-pixels.com",
      VNS_WEB_AI_PROVIDER_READONLY_ENABLED: "true",
    }),
    null,
  );
});

test("disabled BFF never calls upstream and always returns no-store 404", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    throw new Error("Unexpected upstream");
  }) as typeof fetch;
  const response = await readOnlyAdminAiProvidersProxy(req(), null, fetcher);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(called, false);
});

test("non-GET and invalid cookie never leave the BFF", async () => {
  let called = false;
  const fetcher = (async () => {
    called = true;
    throw new Error("Unexpected upstream");
  }) as typeof fetch;
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    const result = await readOnlyAdminAiProvidersProxy(req(method), CFG, fetcher);
    assert.equal(result.status, 405);
  }
  for (const cookie of [
    "",
    "__Host-vns_editor=short",
    SHARED_COOKIE,
    COOKIE + "; __Host-vns_editor=" + "b".repeat(64),
  ]) {
    const result = await readOnlyAdminAiProvidersProxy(req("GET", cookie), CFG, fetcher);
    assert.equal(result.status, 401);
  }
  assert.equal(called, false);
});

test("admin verification and a strictly validated upstream status are mandatory", async () => {
  const urls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    assert.equal(new Headers(init?.headers).get("Cookie"), COOKIE);
    if (url.endsWith("/editor/me")) {
      return Response.json({ role: "admin", username: "ci_admin" });
    }
    if (url.endsWith("/admin/ai-providers")) return Response.json(payload());
    throw new Error("Invalid upstream URL");
  }) as typeof fetch;
  const result = await readOnlyAdminAiProvidersProxy(req(), CFG, fetcher);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), {
    providers: [
      {
        provider: "google_gemini",
        selectedModel: "gemini-3.8-flash-tts",
        configured: false,
        active: false,
      },
      { provider: "openai", selectedModel: "gpt-6.1-sol", configured: false, active: false },
    ],
  });
  assert.deepEqual(urls, [CFG.api + "/editor/me", CFG.api + "/admin/ai-providers"]);
});

test("a valid cookie but a non-admin server session cannot reach provider endpoint", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    if (calls > 1) throw new Error("Provider endpoint must not be queried");
    return Response.json({ role: "editor", username: "ci_editor" });
  }) as typeof fetch;
  const response = await readOnlyAdminAiProvidersProxy(req(), CFG, fetcher);
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
});

test("all unknown, key-bearing or incomplete upstream data fail closed", async () => {
  const examples: unknown[] = [
    { ...payload(), apiKey: "sk-fixture" },
    payload({ apiKey: "sk-fixture" }),
    payload({ ciphertext: "sensitive" }),
    payload({ active: true }),
    payload({ selectedModel: "gpt-unknown" }),
    payload({ selectedModel: "invalid/model" }),
    { providers: [payload().providers[0], payload().providers[0]] },
    { providers: [] },
    { providers: [payload().providers[0]] },
    { providers: null },
    { providers: payload().providers, more: true },
    null,
    [],
  ];
  for (const invalid of examples) {
    assert.equal(parseAdminAiProviders(invalid), null);
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/editor/me")) {
        return Response.json({ role: "admin", username: "ci_admin" });
      }
      return Response.json(invalid);
    }) as typeof fetch;
    const response = await readOnlyAdminAiProvidersProxy(req(), CFG, fetcher);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "temporarily_unavailable" });
  }
});

test("HTTP errors, redirects, oversized and malformed bodies never leak upstream data", async () => {
  for (const upstream of [
    new Response("secret-error", { status: 500 }),
    new Response("secret-redirect", { status: 302, headers: { location: "https://evil.invalid" } }),
    new Response("secret-body", { status: 403 }),
    new Response("x".repeat(4096), { status: 200 }),
    new Response("not-json-key=sk-secret", { status: 200 }),
  ]) {
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/editor/me")) {
        return Response.json({ role: "admin", username: "ci_admin" });
      }
      return upstream;
    }) as typeof fetch;
    const result = await readOnlyAdminAiProvidersProxy(req(), CFG, fetcher);
    assert.ok([403, 503].includes(result.status));
    const body = await result.text();
    assert.ok(!body.includes("secret"));
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
});
