import assert from "node:assert/strict";
import test from "node:test";
import { dormantEditorialAdminProxy } from "./admin-editorial-proxy";

const config = { origin: "https://studio.example.invalid", api: "http://api:4000" };
const cookie = "__Host-vns_editor=" + "a".repeat(64);
const eventId = "ca300003-3333-4333-8333-333333333333";

function request(route: string, method = "GET", data?: unknown, origin = config.origin) {
  return new Request("https://studio.example.invalid" + route, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
function backend(role = "admin") {
  const urls: string[] = [];
  const fetcher = (async (resource: string | URL | Request) => {
    const url = String(resource);
    urls.push(url);
    if (url.endsWith("/editor/me")) {
      return Response.json({ username: "ci_admin", role });
    }
    if (url.includes("editorial-profiles")) {
      return Response.json({ revision: 0, profiles: [] });
    }
    return Response.json({ events: [], nextRevision: 0 });
  }) as typeof fetch;
  return { fetcher, urls };
}

test("feature flag off, missing editor cookie and invalid method have no proxy side effects", async () => {
  const b = backend();
  const req = request("/api/admin/editorial-profiles");
  assert.equal((await dormantEditorialAdminProxy(req, "profiles", null, b.fetcher)).status, 404);
  const forbidden = new Request(req.url);
  assert.equal(
    (await dormantEditorialAdminProxy(forbidden, "profiles", config, b.fetcher)).status,
    401,
  );
  assert.equal(
    (await dormantEditorialAdminProxy(request("/api/admin/editorial-timeline", "POST"),
      "timeline", config, b.fetcher)).status,
    405,
  );
  assert.equal(b.urls.length, 0);
});

test("identity verified upstream, fixed target GET profiles and paginated audit lookup", async () => {
  const b = backend();
  const response = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-profiles"),
    "profiles",
    config,
    b.fetcher,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 0, profiles: [] });
  const exportResponse = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-checkpoints?eventId=" + eventId + "&after=0&limit=10"),
    "checkpoints",
    config,
    b.fetcher,
  );
  assert.equal(exportResponse.status, 200);
  assert.ok(b.urls.every((url) => url.startsWith(config.api + "/")));
  assert.ok(b.urls.includes(config.api + "/admin/editorial-checkpoints?eventId=" +
    eventId + "&after=0&limit=10"));
});

test("reviewer role, forged origin and oversized page query fail without an upstream write", async () => {
  const b = backend("reviewer");
  assert.equal(
    (await dormantEditorialAdminProxy(
      request("/api/admin/editorial-profiles"), "profiles", config, b.fetcher,
    )).status,
    403,
  );
  const target = request("/api/admin/editorial-profiles", "POST",
    { expectedRevision: 0, profiles: [] }, "https://evil.example");
  assert.equal(
    (await dormantEditorialAdminProxy(target, "profiles", config, b.fetcher)).status,
    403,
  );
  assert.equal(
    (await dormantEditorialAdminProxy(
      request("/api/admin/editorial-checkpoints?eventId=" + eventId + "&after=0&limit=101"),
      "checkpoints",
      config,
      b.fetcher,
    )).status,
    400,
  );
  assert.ok(b.urls.every((url) => url.endsWith("/editor/me")));
});
