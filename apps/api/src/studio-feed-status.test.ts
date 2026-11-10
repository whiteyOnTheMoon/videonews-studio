import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import type { AdminAuth } from "./auth.js";
import type { EditorAuth } from "./editor-auth.js";
import {
  StudioFeedStatusService, studioFeedStatusFromEnv,
  type FeedJobEvidence, type FeedStatusReader,
} from "./studio-feed-status.js";

const NOW = new Date("2026-11-10T04:00:00.000Z");
const SLOT = Math.floor(NOW.getTime() / 900000);
const JOB = "vns-feed-tick-" + SLOT;
function auth(yes = true) {
  return { hasAdminSession: () => yes } as unknown as AdminAuth;
}
function editor(role: "admin" | "reviewer" | null = "admin") {
  return {
    authenticatedAdminIdentity: async () =>
      role ? { id: "a0000000-0000-4000-8000-000000000001", role } : null,
  } as unknown as EditorAuth;
}
async function call(svc: StudioFeedStatusService, path = "/admin/studio-news-status?jobId=" + JOB, method = "GET") {
  const server = createServer((req, res) => { void svc.handle(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  try {
    return await fetch("http://127.0.0.1:" + addr.port + path, { method });
  } finally {
    server.close();
  }
}
function reader(value: FeedJobEvidence): { port: FeedStatusReader; calls: string[] } {
  const calls: string[] = [];
  return { port: { async read(id) { calls.push(id); return value; } }, calls };
}
const empty: FeedJobEvidence = { completed: null, failed: null, returnvalue: null, exists: 1 };
test("status disabled without explicit separately credentialed approval", () => {
  assert.equal(studioFeedStatusFromEnv(undefined, undefined, {}), undefined);
  assert.throws(
    () => studioFeedStatusFromEnv(auth(), editor(), {
      VNS_STUDIO_FEED_STATUS_API_ENABLED: "true",
    }),
    /not authorized/,
  );
});
test("completed requires BullMQ completed index and exact worker returnvalue", async () => {
  const end = NOW.getTime() - 1000;
  const p = reader({
    completed: String(end), failed: null, exists: 1,
    returnvalue: JSON.stringify({
      ok: true, sourcesExamined: 3, candidatesAdded: 2, notModified: 1,
    }),
  });
  const res = await call(new StudioFeedStatusService(auth(), editor(), p.port, () => NOW));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    jobId: JOB, state: "completed", finishedAt: new Date(end).toISOString(),
    summary: { sourcesExamined: 3, candidatesAdded: 2, notModified: 1 },
    publishingAllowed: false,
  });
  assert.deepEqual(p.calls, [JOB]);
});
test("pending, missing and failed cannot claim completion", async () => {
  for (const [e, expected] of [
    [empty, "pending"],
    [{ ...empty, exists: 0 }, "unknown"],
    [{ ...empty, completed: null, failed: String(NOW.getTime()), exists: 1 }, "failed"],
  ] as const) {
    const result = await call(new StudioFeedStatusService(auth(), editor(), reader(e).port, () => NOW));
    const data = await result.json();
    assert.equal(data.state, expected);
    assert.equal(data.summary, null);
    assert.equal(data.publishingAllowed, false);
  }
});
test("wrong actor, malformed/stale/future job and wrong method never read Redis", async () => {
  const r = reader(empty);
  assert.equal((await call(new StudioFeedStatusService(auth(false), editor(), r.port, () => NOW))).status, 401);
  assert.equal((await call(new StudioFeedStatusService(auth(), editor("reviewer"), r.port, () => NOW))).status, 403);
  const svc = new StudioFeedStatusService(auth(), editor(), r.port, () => NOW);
  assert.equal((await call(svc, "/admin/studio-news-status?jobId=invalid")).status, 400);
  assert.equal((await call(svc, "/admin/studio-news-status?jobId=" + JOB + "&jobId=" + JOB)).status, 400);
  assert.equal((await call(svc, "/admin/studio-news-status?jobId=vns-feed-tick-1")).status, 400);
  assert.equal((await call(svc, "/admin/studio-news-status?jobId=vns-feed-tick-" + (SLOT + 2))).status, 400);
  assert.equal((await call(svc, "/admin/studio-news-status?jobId=" + JOB, "POST")).status, 405);
  assert.equal(r.calls.length, 0);
});
test("forged completed index, corrupt payload and Redis errors fail closed", async () => {
  const invalid: FeedJobEvidence[] = [
    { ...empty, completed: String(NOW.getTime()), failed: "1" },
    { ...empty, completed: String(NOW.getTime()), returnvalue: "{}" },
    { ...empty, completed: String(NOW.getTime()), returnvalue: '{"ok":true,"sourcesExamined":3,"candidatesAdded":0,"notModified":0,"apiKey":"leak"}' },
    { ...empty, completed: "9999999999999999", returnvalue: '{"ok":true,"sourcesExamined":3,"candidatesAdded":0,"notModified":0}' },
  ];
  for (const value of invalid) {
    const res = await call(new StudioFeedStatusService(auth(), editor(), reader(value).port, () => NOW));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "temporarily_unavailable" });
  }
  const failed = new StudioFeedStatusService(
    auth(), editor(),
    { async read() { throw new Error("private Redis password"); } }, () => NOW,
  );
  const res = await call(failed);
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /password/);
});
