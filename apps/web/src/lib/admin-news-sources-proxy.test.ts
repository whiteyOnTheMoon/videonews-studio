import assert from "node:assert/strict";
import test from "node:test";
import {
  dormantSourceAdminProxy,
  parseSourceAdminProxyCommand,
  sourceAdminProxyConfig,
} from "./admin-news-sources-proxy";

const ORIGIN = "https://studio.ap-pixels.com";
const COOKIE = "__Host-vns_editor=" + "a".repeat(64);
const CFG = { origin: ORIGIN, api: "http://api:4000" };
const source = {
  id: "ci_source",
  baseUrl: "https://example.org/news/",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "Synthetic fixture metadata only.",
};
const command = { action: "create_pending", expectedRevision: 0, source };
function req(method: string, value: unknown = command, cookie = COOKIE, origin = ORIGIN): Request {
  return new Request(ORIGIN + "/api/admin/news-sources", {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(value) } : {}),
  });
}
test("feature needs its own flag and personal editor auth", () => {
  const env = {
    VNS_WEB_ADMIN_ENABLED: "true",
    VNS_ADMIN_ORIGIN: ORIGIN,
    VNS_API_INTERNAL_URL: CFG.api,
    VNS_WEB_ADMIN_JOBS_ENABLED: "true",
    VNS_WEB_EDITOR_AUTH_ENABLED: "true",
  };
  assert.equal(sourceAdminProxyConfig(env), null);
  assert.deepEqual(
    sourceAdminProxyConfig({ ...env, VNS_WEB_SOURCE_REGISTRY_ENABLED: "true" }),
    CFG,
  );
  assert.equal(
    sourceAdminProxyConfig({
      ...env,
      VNS_WEB_EDITOR_AUTH_ENABLED: "false",
      VNS_WEB_SOURCE_REGISTRY_ENABLED: "true",
    }),
    null,
  );
});
test("schema rejects client-set status, actor and unsafe source input", () => {
  assert.deepEqual(parseSourceAdminProxyCommand(command), command);
  for (const value of [
    { ...command, actorId: "forged" },
    { ...command, status: "approved" },
    { ...command, source: { ...source, status: "approved" } },
    { ...command, source: { ...source, baseUrl: "http://internal.local/" } },
    { ...command, source: { ...source, intervalMinutes: 1 } },
    { ...command, source: { ...source, licenseNotes: "tiny" } },
    { action: "delete", expectedRevision: 0, sourceId: source.id },
    { action: "approve", expectedRevision: 0, sourceId: "not ok" },
    { action: "approve", expectedRevision: 0, sourceId: source.id, feedActive: true },
    { action: "approve", expectedRevision: -1, sourceId: source.id },
  ]) {
    assert.equal(parseSourceAdminProxyCommand(value), null);
  }
});
test("disabled, foreign Origin and shared admin cookies fail before fetch", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw new Error("No upstream allowed");
  }) as typeof fetch;
  assert.equal((await dormantSourceAdminProxy(req("POST"), null, fetcher)).status, 404);
  assert.equal((await dormantSourceAdminProxy(req("PUT"), CFG, fetcher)).status, 405);
  assert.equal(
    (await dormantSourceAdminProxy(req("POST", command, COOKIE, "https://other.invalid"), CFG, fetcher)).status,
    403,
  );
  assert.equal(
    (await dormantSourceAdminProxy(req("POST", command, "__Host-vns_session=" + "b".repeat(64)), CFG, fetcher)).status,
    401,
  );
  assert.equal(calls, 0);
});
test("personal editor role cannot query or mutate source registry", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    if (calls === 1) return Response.json({ username: "ci_editor", role: "editor" });
    throw new Error("Source API accessed");
  }) as typeof fetch;
  assert.equal((await dormantSourceAdminProxy(req("POST"), CFG, fetcher)).status, 403);
  assert.equal(calls, 1);
});
test("authorized GET and POST use only forwarded editor cookie and canonical fields", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    assert.equal(new Headers(init?.headers).get("Cookie"), COOKIE);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.cache, "no-store");
    if (url.endsWith("/editor/me")) {
      return Response.json({ username: "ci_admin", role: "admin" });
    }
    assert.equal(url, CFG.api + "/admin/news-sources");
    if (init?.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), command);
      assert.equal(new Headers(init.headers).get("origin"), ORIGIN);
      return Response.json({
        saved: true,
        revision: 1,
        sourceId: source.id,
        status: "pending",
        feedActive: false,
      });
    }
    return Response.json({
      revision: 1,
      sources: [{ ...source, status: "pending", reviewedAt: "2026-10-26" }],
    });
  }) as typeof fetch;
  const saved = await dormantSourceAdminProxy(req("POST"), CFG, fetcher);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual(await saved.json(), {
    saved: true,
    revision: 1,
    sourceId: source.id,
    status: "pending",
    feedActive: false,
  });
  const read = await dormantSourceAdminProxy(req("GET"), CFG, fetcher);
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { sources: unknown[] }).sources.length, 1);
  assert.deepEqual(calls, [
    CFG.api + "/editor/me",
    CFG.api + "/admin/news-sources",
    CFG.api + "/editor/me",
    CFG.api + "/admin/news-sources",
  ]);
});
test("malformed JSON, unexpected key material, redirects or activation fail closed", async () => {
  const responses = [
    Response.json({ saved: true, revision: 1, sourceId: source.id, status: "pending", feedActive: true }),
    Response.json({ saved: true, revision: 1, sourceId: source.id, status: "pending", feedActive: false, secret: "sensitive" }),
    Response.json({ saved: true, revision: 22, sourceId: source.id, status: "pending", feedActive: false }),
    new Response("redirect", { status: 302, headers: { location: "https://evil.invalid" } }),
    new Response("apiKey=secret", { status: 500 }),
  ];
  for (const upstream of responses) {
    const fetcher = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/editor/me")
        ? Response.json({ username: "ci_admin", role: "admin" })
        : upstream) as typeof fetch;
    const res = await dormantSourceAdminProxy(req("POST"), CFG, fetcher);
    assert.equal(res.status, 503);
    assert.ok(!(await res.text()).includes("secret"));
  }
  const fetcher = (async (input: RequestInfo | URL) =>
    String(input).endsWith("/editor/me")
      ? Response.json({ username: "ci_admin", role: "admin" })
      : Response.json({ revision: 1, sources: [{ ...source, status: "pending", reviewedAt: "2026-10-26", apiKey: "secret" }] })) as typeof fetch;
  assert.equal((await dormantSourceAdminProxy(req("GET"), CFG, fetcher)).status, 503);
});
