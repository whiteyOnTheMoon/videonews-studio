import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import {
  createDormantFeedScheduler,
  type OfflineFeedSchedulerPorts,
} from "./feed-scheduler-composition.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "./research-service-config.js";

const ROOT = "https://www.example.org/";
const TOKEN = "11111111-2222-4333-8444-555555555555";
const START = Date.parse("2026-10-26T12:00:00.000Z");
const env: NodeJS.ProcessEnv = {
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
  VNS_FEED_REGISTRY_FILE: REVIEWED_SOURCE_REGISTRY_PATH,
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: "www.example.org",
};

function source(
  id: string,
  path: string,
  status: "approved" | "pending" | "blocked",
  access: "rss" | "atom" | "official_api",
) {
  return {
    id,
    baseUrl: ROOT + path,
    status,
    access,
    intervalMinutes: 60,
    termsUrl: ROOT + "terms/",
    usage: "metadata_only",
    licenseNotes: "Fixture metadata only; human rights review is required.",
    reviewedAt: "2026-10-26",
  };
}

const SOURCES = [
  source("agency_rss", "rss/", "approved", "rss"),
  source("agency_atom", "atom/", "approved", "atom"),
  source("agency_json", "api/", "approved", "official_api"),
  source("agency_blocked", "rss/restricted/", "blocked", "rss"),
  source("agency_pending", "preview/", "pending", "rss"),
];
const registryJson = () => JSON.stringify({ version: 1, sources: SOURCES });
const responses: Record<string, { type: string; body: string }> = {
  "/rss/": {
    type: "application/rss+xml",
    body:
      "<rss><channel><item><title>Regional transport strategy published</title>" +
      "<link>" +
      ROOT +
      "rss/article-1</link></item></channel></rss>",
  },
  "/atom/": {
    type: "application/atom+xml",
    body:
      '<feed><entry><title>City transport policy reviewed today</title><link href="' +
      ROOT +
      'atom/article-2" /></entry></feed>',
  },
  "/api/": {
    type: "application/json",
    body: JSON.stringify({
      items: [
        { url: ROOT + "api/article-3", headline: "Agency reports new public transport guidance" },
      ],
    }),
  },
};

function fixture() {
  let dbNow = START;
  let cached = false;
  let readCount = 0;
  const requests: Array<{ path: string; ip: string; etag: string | undefined }> = [];
  const saved = new Set<string>();
  const db = new Map<
    string,
    { next: number; token: string; etag: string | null; modified: string | null }
  >();
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const pool = {
    async query(sql: string, args: unknown[]) {
      queries.push({ sql, args });
      if (sql.includes("vns.claim_feed_poll")) {
        const id = String(args[0]);
        const state = db.get(id);
        if (state && dbNow < state.next) return { rows: [] };
        const next = {
          next: dbNow + Number(args[1]) * 60000,
          token: TOKEN,
          etag: state?.etag ?? null,
          modified: state?.modified ?? null,
        };
        db.set(id, next);
        return {
          rows: [
            {
              token: next.token,
              etag: next.etag,
              last_modified: next.modified,
            },
          ],
        };
      }
      if (sql.includes("vns.commit_feed_poll")) {
        const id = String(args[0]);
        const state = db.get(id);
        if (!state || args[1] !== state.token) throw new Error("private SQL secret");
        const items = JSON.parse(String(args[2])) as Array<{ url: string }>;
        let created = 0;
        for (const item of items) {
          const key = id + "|" + item.url;
          if (!saved.has(key)) {
            saved.add(key);
            created++;
          }
        }
        state.etag = args[3] as string | null;
        state.modified = args[4] as string | null;
        return { rows: [{ created }] };
      }
      throw new Error("Unexpected SQL");
    },
  } as unknown as Pool;

  const ports: OfflineFeedSchedulerPorts = {
    pool,
    readRegistry(path) {
      readCount++;
      assert.equal(path, REVIEWED_SOURCE_REGISTRY_PATH);
      return registryJson();
    },
    https: {
      async resolveIPv4(host) {
        assert.equal(host, "www.example.org");
        return ["1.1.1.1"];
      },
      async requestPinned(url, ip, headers) {
        requests.push({ path: url.pathname, ip, etag: headers["If-None-Match"] });
        const response = responses[url.pathname];
        if (!response) throw new Error("Unreviewed source was fetched");
        if (cached) return { status: 304, headers: {}, body: Buffer.alloc(0) };
        return {
          status: 200,
          headers: {
            "content-type": response.type,
            etag: '"synthetic-v1"',
          },
          body: Buffer.from(response.body),
        };
      },
    },
  };
  return {
    ports,
    queries,
    requests,
    saved,
    db,
    get readCount() {
      return readCount;
    },
    setNow(minutes: number) {
      dbNow = START + minutes * 60000;
    },
    use304() {
      cached = true;
    },
  };
}

test("full offline register to pinned HTTPS to SQL composition is idempotent", async () => {
  const f = fixture();
  const scheduler = createDormantFeedScheduler(env, f.ports);
  assert.deepEqual(scheduler.sourceIds, ["agency_rss", "agency_atom", "agency_json"]);
  const clock = new Date(START);
  assert.deepEqual(await scheduler.tick(clock), [
    { sourceId: "agency_rss", status: "ingested", newItems: 1 },
    { sourceId: "agency_atom", status: "ingested", newItems: 1 },
    { sourceId: "agency_json", status: "ingested", newItems: 1 },
  ]);
  assert.equal(f.readCount, 1);
  assert.equal(f.saved.size, 3);
  assert.deepEqual(
    f.requests.map((x) => x.path),
    ["/rss/", "/atom/", "/api/"],
  );
  assert.ok(f.requests.every((x) => x.ip === "1.1.1.1"));
  assert.deepEqual(await scheduler.tick(new Date(START + 59000)), []);
  assert.equal(f.requests.length, 3);

  f.setNow(60);
  f.use304();
  assert.ok(
    (await scheduler.tick(new Date(START + 3600000))).every(
      (result) => result.status === "not_modified" && result.newItems === 0,
    ),
  );
  assert.ok(f.requests.slice(3).every((x) => x.etag === '"synthetic-v1"'));
  assert.equal(f.saved.size, 3);
  assert.ok(f.queries.every((query) => !query.sql.includes("article-1")));
  assert.ok(f.queries.every((query) => !query.sql.includes("CREATE ")));
  assert.deepEqual([...f.db.keys()], ["agency_rss", "agency_atom", "agency_json"]);
});

test("missing offline gates and host approval are rejected before registry or SQL", () => {
  const deniedSettings: Array<[string, string]> = [
    ["VNS_FEED_OFFLINE_COMPOSITION_ENABLED", "false"],
    ["VNS_FEED_OFFLINE_OPERATOR_ACK", "false"],
    ["VNS_FEED_REGISTRY_FILE", "/tmp/unapproved.json"],
    ["VNS_SOURCE_FETCH_ENABLED", "false"],
    ["VNS_ALLOWED_SOURCE_HOSTS", "localhost"],
  ];
  for (const [key, value] of deniedSettings) {
    const f = fixture();
    assert.throws(() => createDormantFeedScheduler({ ...env, [key]: value }, f.ports));
    assert.equal(f.readCount, 0);
    assert.equal(f.queries.length, 0);
    assert.equal(f.requests.length, 0);
  }
});

test("explicit ports and three approved sources are mandatory", () => {
  const f = fixture();
  const missing = {
    ...f.ports,
    https: { ...f.ports.https, resolveIPv4: undefined },
  } as unknown as OfflineFeedSchedulerPorts;
  assert.throws(() => createDormantFeedScheduler(env, missing), /explicit test ports/);
  assert.equal(f.readCount, 0);
  assert.throws(
    () =>
      createDormantFeedScheduler(env, {
        ...f.ports,
        readRegistry: () => {
          throw new Error("SECRET_REGISTRY");
        },
      }),
    (error: unknown) =>
      error instanceof Error && error.message === "Reviewed feed registry unavailable",
  );
  assert.throws(
    () =>
      createDormantFeedScheduler(env, {
        ...f.ports,
        readRegistry: () => JSON.stringify({ version: 1, sources: SOURCES.slice(0, 2) }),
      }),
    /three to five reviewed sources/,
  );
  assert.equal(f.queries.length, 0);
  assert.equal(f.requests.length, 0);
});

test("injected DNS and SQL failures yield sanitized source outcomes", async () => {
  const f = fixture();
  const scheduler = createDormantFeedScheduler(env, {
    ...f.ports,
    https: {
      ...f.ports.https,
      resolveIPv4: async () => ["127.0.0.1"],
    },
  });
  const denied = await scheduler.tick(new Date(START));
  assert.equal(denied.length, 3);
  assert.ok(denied.every((result) => result.status === "failed"));
  assert.equal(f.saved.size, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(JSON.stringify(denied).includes("127.0.0.1"), false);
});

test("database outage fails closed before any HTTPS request", async () => {
  const f = fixture();
  const unavailable = {
    async query(): Promise<never> {
      throw new Error("VERY_SECRET_SQL_PASSWORD");
    },
  } as unknown as Pool;
  const scheduler = createDormantFeedScheduler(env, { ...f.ports, pool: unavailable });
  const results = await scheduler.tick(new Date(START));
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.status === "failed"));
  assert.equal(JSON.stringify(results).includes("SECRET"), false);
  assert.equal(f.requests.length, 0);
});
