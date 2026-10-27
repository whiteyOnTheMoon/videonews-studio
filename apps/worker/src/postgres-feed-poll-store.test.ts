import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { PostgresFeedPollStore } from "./postgres-feed-poll-store.js";
import type { RegisteredResearchSource } from "./source-registry.js";

const TOKEN = "11111111-2222-4333-8444-555555555555";
const clock = new Date("2026-10-26T12:00:00.000Z");
const item = {
  sourceId: "agency_feed",
  url: "https://www.example.org/rss/report-1",
  headline: "Transport update published today",
  publishedAt: null,
  reviewStatus: "candidate" as const,
};

test("PostgreSQL lease uses database clock, parameterized SQL and token binding", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("claim_feed_poll")) {
        return { rows: [{ token: TOKEN, etag: '"cached"', last_modified: null }] };
      }
      if (sql.includes("commit_feed_poll")) return { rows: [{ created: 1 }] };
      throw new Error("Unexpected feed query");
    },
  } as unknown as Pool;
  const store = new PostgresFeedPollStore(pool);
  assert.deepEqual(await store.claim("agency_feed", clock, 60), {
    token: TOKEN,
    validators: { etag: '"cached"', lastModified: null },
  });
  assert.equal(
    await store.commit("agency_feed", TOKEN, [item], {
      etag: '"new-cache"',
      lastModified: null,
    }),
    1,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]?.params, ["agency_feed", 60]);
  assert.deepEqual(calls[1]?.params?.slice(0, 2), ["agency_feed", TOKEN]);
  assert.deepEqual(JSON.parse(String(calls[1]?.params[2])), [
    { url: item.url, headline: item.headline, publishedAt: null },
  ]);
  assert.ok(calls.every((call) => !call.sql.includes(item.url)));
  assert.equal(JSON.stringify(calls).includes("reviewStatus"), false);
});

test("missing claims, failed lease and invalid input fail closed", async () => {
  let queries = 0;
  const pool = {
    async query(sql: string) {
      queries++;
      return sql.includes("claim_feed_poll") ? { rows: [] } : { rows: [{ created: 0 }] };
    },
  } as unknown as Pool;
  const store = new PostgresFeedPollStore(pool);
  assert.equal(await store.claim("agency_feed", clock, 60), null);
  for (const id of ["bad id", "x", "agency_feed;DROP TABLE x"]) {
    await assert.rejects(store.claim(id, clock, 60), /rejected/);
  }
  await assert.rejects(store.claim("agency_feed", clock, 5), /rejected/);
  await assert.rejects(store.claim("agency_feed", new Date("invalid"), 60), /rejected/);
  await assert.rejects(
    store.commit("agency_feed", "invalid", [item], { etag: null, lastModified: null }),
    /rejected/,
  );
  await assert.rejects(
    store.commit("agency_feed", TOKEN, [{ ...item, reviewStatus: "verified" as "candidate" }], {
      etag: null,
      lastModified: null,
    }),
    /rejected/,
  );
  await assert.rejects(
    store.commit("agency_feed", TOKEN, [{ ...item, sourceId: "another_feed" }], {
      etag: null,
      lastModified: null,
    }),
    /rejected/,
  );
  assert.equal(queries, 1);
});

test("unexpected SQL response and lost lease result cannot be counted as success", async () => {
  const pool = {
    async query() {
      return { rows: [{ created: 22 }] };
    },
  } as unknown as Pool;
  const store = new PostgresFeedPollStore(pool);
  await assert.rejects(store.claim("agency_feed", clock, 60), /unavailable/);
  await assert.rejects(
    store.commit("agency_feed", TOKEN, [item], { etag: null, lastModified: null }),
    /invalid/,
  );
});

test("live mode sends the complete source snapshot to guarded SQL", async () => {
  const source: RegisteredResearchSource = {
    id: "agency_feed",
    baseUrl: "https://www.example.org/rss/",
    status: "approved",
    access: "rss",
    intervalMinutes: 60,
    termsUrl: "https://www.example.org/terms/",
    usage: "metadata_only",
    licenseNotes: "Synthetic source used for guarded SQL tests.",
    reviewedAt: "2026-10-26",
  };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("claim_feed_poll_authorized")) {
        return { rows: [{ token: TOKEN, etag: null, last_modified: null }] };
      }
      if (sql.includes("commit_feed_poll_authorized")) {
        return { rows: [{ created: 1 }] };
      }
      throw new Error("Unguarded SQL must never be invoked");
    },
  } as unknown as Pool;
  const store = new PostgresFeedPollStore(pool, new Map([[source.id, source]]));
  await assert.rejects(store.claim(source.id, clock, 15), /rejected/);
  await assert.rejects(store.claim("unknown_feed", clock, 60), /authorization required/);
  assert.equal(calls.length, 0);
  assert.equal((await store.claim(source.id, clock, 60))?.token, TOKEN);
  assert.equal(
    await store.commit(source.id, TOKEN, [item], { etag: null, lastModified: null }),
    1,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.sql.includes("_authorized(")));
  assert.deepEqual(calls.map((call) => JSON.parse(String(call.params[0]))), [source, source]);
  assert.equal(calls[1]?.params[1], TOKEN);
});
