import assert from "node:assert/strict";
import test from "node:test";
import { studioFeedStatusProxy, studioFeedStatusProxyConfig } from "./studio-feed-status-proxy";
import { validStudioFeedStatus } from "./studio-feed-status";

const config = { origin: "https://studio.ap-pixels.com", api: "http://api:4000" };
const job = "vns-feed-tick-1992000";
const cookie = "__Host-vns_session=" + "a".repeat(64) + "; __Host-vns_editor=" + "b".repeat(64);
function request(path = "/api/admin/studio-news-status?jobId=" + job, cookies = cookie, method = "GET") {
  return new Request(config.origin + path, { method, headers: { Cookie: cookies } });
}
function backend(status = 200, state = "completed") {
  const calls: string[] = [];
  const fetcher = (async (resource: string | URL | Request) => {
    const target = String(resource);
    calls.push(target);
    if (target.endsWith("/admin/me")) return Response.json({ role: "admin" });
    if (target.endsWith("/editor/me")) return Response.json({ username: "operator", role: "admin" });
    return Response.json({
      jobId: job, state, publishingAllowed: false,
      finishedAt: state === "completed" ? "2026-11-10T04:07:00.000Z" : null,
      summary: state === "completed"
        ? { sourcesExamined: 3, candidatesAdded: 4, notModified: 1 }
        : null,
    }, { status });
  }) as typeof fetch;
  return { calls, fetcher };
}
test("read-only status starts disabled and cannot read anonymously or with bad params", async () => {
  const b = backend();
  assert.equal(studioFeedStatusProxyConfig({}), null);
  assert.equal((await studioFeedStatusProxy(request(), null, b.fetcher)).status, 404);
  assert.equal((await studioFeedStatusProxy(request(undefined, ""), config, b.fetcher)).status, 401);
  for (const path of [
    "/api/admin/studio-news-status",
    "/api/admin/studio-news-status?jobId=../../private",
    "/api/admin/studio-news-status?jobId=" + job + "&jobId=" + job,
    "/api/admin/studio-news-status?jobId=" + job + "&url=evil",
  ]) assert.equal((await studioFeedStatusProxy(request(path), config, b.fetcher)).status, 400);
  assert.equal((await studioFeedStatusProxy(request(undefined, cookie, "POST"), config, b.fetcher)).status, 405);
  assert.equal(b.calls.length, 0);
});
test("admin-only status mirrors validated completed evidence, never queue or source secrets", async () => {
  const b = backend();
  const res = await studioFeedStatusProxy(request(), config, b.fetcher);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const value: unknown = await res.json();
  assert.equal(validStudioFeedStatus(value, job), true);
  assert.deepEqual(b.calls, [
    "http://api:4000/admin/me",
    "http://api:4000/editor/me",
    "http://api:4000/admin/studio-news-status?jobId=" + job,
  ]);
  const reviewer = (async (url: string | URL | Request) =>
    String(url).endsWith("/admin/me")
      ? Response.json({ role: "admin" })
      : Response.json({ username: "reviewer", role: "reviewer" })
  ) as typeof fetch;
  assert.equal((await studioFeedStatusProxy(request(), config, reviewer)).status, 403);
});
test("pending is not completion, upstream redirect and corrupt payload fail closed", async () => {
  const b = backend(200, "pending");
  const pending = await studioFeedStatusProxy(request(), config, b.fetcher);
  assert.equal(pending.status, 200);
  const parsed: any = await pending.json();
  assert.equal(parsed.summary, null);
  assert.equal(parsed.state, "pending");
  assert.equal((await studioFeedStatusProxy(request(), config, backend(302).fetcher)).status, 503);
  for (const bad of [
    { jobId: job, state: "completed", finishedAt: null, summary: null, publishingAllowed: false },
    { jobId: job, state: "completed", finishedAt: "2026-11-10T04:07:00.000Z", summary: { sourcesExamined: 3, candidatesAdded: -1, notModified: 1 }, publishingAllowed: false },
    { jobId: job, state: "completed", finishedAt: "2026-11-10T04:07:00.000Z", summary: { sourcesExamined: 3, candidatesAdded: 3, notModified: 1 }, publishingAllowed: true },
  ]) assert.equal(validStudioFeedStatus(bad, job), false);
});
