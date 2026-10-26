import assert from "node:assert/strict";
import test from "node:test";
import { PostgresSourceAdminStore, type SourceQueryPort } from "./source-admin-postgres.js";
import type { SourceAuditEvent, SourceSnapshot } from "./admin-source-registry.js";

const source = {
  id: "sample_news",
  baseUrl: "https://news.example.org/feed/",
  access: "rss" as const,
  intervalMinutes: 60,
  termsUrl: "https://news.example.org/terms/",
  usage: "metadata_only" as const,
  licenseNotes: "Synthetic test source metadata only.",
  status: "pending" as const,
  reviewedAt: "2026-10-26",
};
const snapshot: SourceSnapshot = { revision: 1, sources: [source] };
const event: SourceAuditEvent = {
  actorId: "12345678-1234-4123-8123-123456789012",
  actorUsername: "editor",
  actorAuthVersion: 0,
  sourceId: source.id,
  action: "create_pending",
  revision: 1,
  recordedAt: "2026-10-26T00:00:00.000Z",
};
test("dormant reader validates PostgreSQL snapshot", async () => {
  const store = new PostgresSourceAdminStore({
    async query(sql) {
      assert.match(sql, /^SELECT revision/);
      return { rows: [{ revision: "1", sources: [source] }] };
    },
  });
  assert.deepEqual(await store.read(), snapshot);
});
test("writer passes positional parameters to atomic function and returns CAS conflict", async () => {
  let calls = 0;
  const pool: SourceQueryPort = {
    async query(sql, params) {
      calls++;
      assert.match(sql, /admin_commit_source_registry\(\$1,\$2/);
      assert.equal(params?.[0], 0);
      assert.equal(params?.[1], 1);
      assert.equal(params?.[4], "create_pending");
      assert.equal(params?.[5], event.actorId);
      assert.equal(JSON.parse(params?.[2] as string)[0].id, source.id);
      return { rows: [{ saved: false }] };
    },
  };
  assert.equal(
    await new PostgresSourceAdminStore(pool).saveWithAudit(0, snapshot, event),
    "conflict",
  );
  assert.equal(calls, 1);
});
test("invalid revision and malformed snapshots never reach SQL", async () => {
  const pool: SourceQueryPort = {
    async query() {
      throw new Error("Unexpected SQL");
    },
  };
  const store = new PostgresSourceAdminStore(pool);
  await assert.rejects(store.saveWithAudit(3, snapshot, event), /invalid/);
  await assert.rejects(
    store.saveWithAudit(
      0,
      { revision: 1, sources: [{ ...source, status: "unsafe" }] } as unknown as SourceSnapshot,
      event,
    ),
    /unavailable/,
  );
});
