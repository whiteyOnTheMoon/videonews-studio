import assert from "node:assert/strict";
import test from "node:test";
import { studioNewsRefreshProxy, studioNewsRefreshProxyConfig } from "./studio-news-refresh-proxy";

const config = { origin: "https://studio.ap-pixels.com", api: "http://api:4000" };
const cookies = "__Host-vns_session=" + "a".repeat(64) + "; __Host-vns_editor=" + "b".repeat(64);

function req(
  cookie = cookies,
  origin = config.origin,
  method = "POST",
  path = "/api/admin/studio-news-refresh",
) {
  return new Request(config.origin + path, { method, headers: { cookie, origin } });
}

function backend(status = 202) {
  const calls: string[] = [];
  const fetchMock = (async (resource: string | URL | Request) => {
    const url = String(resource);
    calls.push(url);
    if (url.endsWith("/admin/me")) return Response.json({ role: "admin" });
    if (url.endsWith("/editor/me")) return Response.json({ username: "operator", role: "admin" });
    return Response.json(
      {
        accepted: true,
        queueJobId: "vns-feed-tick-1992000",
        completed: false,
        publishingAllowed: false,
      },
      { status },
    );
  }) as typeof fetch;
  return { calls, fetchMock };
}

test("feature off and missing credentials never contact backend", async () => {
  assert.equal(studioNewsRefreshProxyConfig({}), null);
  const f = backend();
  assert.equal((await studioNewsRefreshProxy(req(), null, f.fetchMock)).status, 404);
  assert.equal((await studioNewsRefreshProxy(req(""), config, f.fetchMock)).status, 401);
  assert.equal(
    (await studioNewsRefreshProxy(req(cookies, "https://evil.invalid"), config, f.fetchMock))
      .status,
    403,
  );
  assert.equal(
    (await studioNewsRefreshProxy(req(cookies, config.origin, "GET"), config, f.fetchMock)).status,
    405,
  );
  assert.equal(
    (
      await studioNewsRefreshProxy(
        req(
          cookies,
          config.origin,
          "POST",
          "/api/admin/studio-news-refresh?url=https://evil.invalid",
        ),
        config,
        f.fetchMock,
      )
    ).status,
    400,
  );
  assert.equal(f.calls.length, 0);
});

test("only doubly authenticated admin may enqueue, not claim completion", async () => {
  const f = backend();
  const res = await studioNewsRefreshProxy(req(), config, f.fetchMock);
  assert.equal(res.status, 202);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await res.json(), {
    accepted: true,
    queueJobId: "vns-feed-tick-1992000",
    completed: false,
    publishingAllowed: false,
  });
  assert.deepEqual(f.calls, [
    "http://api:4000/admin/me",
    "http://api:4000/editor/me",
    "http://api:4000/admin/studio-news-refresh",
  ]);
  const wrongRole = (async (resource: string | URL | Request) => {
    if (String(resource).endsWith("/admin/me")) return Response.json({ role: "admin" });
    if (String(resource).endsWith("/editor/me"))
      return Response.json({ username: "editor", role: "reviewer" });
    throw new Error("unexpected queue dispatch");
  }) as typeof fetch;
  assert.equal((await studioNewsRefreshProxy(req(), config, wrongRole)).status, 403);
});

test("failed producer, forged completion and unexpected fields fail closed", async () => {
  assert.equal((await studioNewsRefreshProxy(req(), config, backend(503).fetchMock)).status, 503);
  const forged = (async (resource: string | URL | Request) => {
    const url = String(resource);
    if (url.endsWith("/admin/me")) return Response.json({ role: "admin" });
    if (url.endsWith("/editor/me")) return Response.json({ username: "operator", role: "admin" });
    return Response.json(
      {
        accepted: true,
        queueJobId: "vns-feed-tick-1992000",
        completed: true,
        publishingAllowed: false,
        sourceUrl: "http://127.0.0.1/secret",
      },
      { status: 202 },
    );
  }) as typeof fetch;
  assert.equal((await studioNewsRefreshProxy(req(), config, forged)).status, 503);
});
