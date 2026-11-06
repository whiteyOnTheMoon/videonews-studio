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
  const currentlyApproved = new Set(["agency_rss", "agency_atom", "agency_json"]);
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
      if (sql.includes("vns.feed_runtime_source_authorized")) {
        const source = JSON.parse(String(args[0])) as { id: string };
        return { rows: [{ authorized: currentlyApproved.has(source.id) }] };
      }
      if (sql.includes("vns.claim_feed_poll")) {
        const id = sql.includes("_authorized")
          ? (JSON.parse(String(args[0])) as { id: string }).id
          : String(args[0]);
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
        const id = sql.includes("_authorized")
          ? (JSON.parse(String(args[0])) as { id: string }).id
          : String(args[0]);
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
    revoke(sourceId: string) {
      currentlyApproved.delete(sourceId);
    },
    approve(sourceId: string) {
      currentlyApproved.add(sourceId);
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

test("runtime checks source grants at feed boundaries", async () => {
  const f = fixture();
  const scheduler = createDormantFeedScheduler(
    { ...env, VNS_FEED_RUNTIME_ENABLED: "true" },
    f.ports,
  );
  f.revoke("agency_rss");
  const results = await scheduler.tick(new Date(START));
  assert.deepEqual(results, [
    { sourceId: "agency_rss", status: "failed", newItems: 0 },
    { sourceId: "agency_atom", status: "ingested", newItems: 1 },
    { sourceId: "agency_json", status: "ingested", newItems: 1 },
  ]);
  assert.deepEqual(
    f.requests.map((x) => x.path),
    ["/atom/", "/api/"],
  );
  assert.deepEqual([...f.db.keys()], ["agency_atom", "agency_json"]);
  assert.equal(f.saved.size, 2);
  const admissions = f.queries.filter((x) => x.sql.includes("feed_runtime_source_authorized"));
  assert.equal(admissions.length, 7);
});

test("live authority denies all sources without touching network or feed leases", async () => {
  const f = fixture();
  for (const id of ["agency_rss", "agency_atom", "agency_json"]) f.revoke(id);
  const scheduler = createDormantFeedScheduler(
    { ...env, VNS_FEED_RUNTIME_ENABLED: "true" },
    f.ports,
  );
  const results = await scheduler.tick(new Date(START));
  assert.equal(results.length, 3);
  assert.ok(results.every((x) => x.status === "failed" && x.newItems === 0));
  assert.equal(f.requests.length, 0);
  assert.equal(f.db.size, 0);
  const seen = f.queries.filter((x) => x.sql.includes("feed_runtime_source_authorized"));
  assert.equal(seen.length, 3);
});

test("explicit NOAA-only manual canary does not claim leases or contact NASA/USGS", async () => {
  const f = fixture();
  f.approve("noaa_news");
  const noaa = {
    ...source("noaa_news", "rss/", "approved", "rss"),
    baseUrl: "https://www.noaa.gov/",
    feedUrl: "https://www.noaa.gov/rss.xml",
    termsUrl: "https://www.noaa.gov/terms/",
  };
  const approved = [noaa, SOURCES[1]!, SOURCES[2]!, SOURCES[3]!, SOURCES[4]!];
  const received: string[] = [];
  const ports: OfflineFeedSchedulerPorts = {
    ...f.ports,
    readRegistry: () => JSON.stringify({ version: 1, sources: approved }),
    https: {
      resolveIPv4: async (hostname) => {
        received.push("dns:" + hostname);
        return ["1.1.1.1"];
      },
      requestPinned: async (url) => {
        received.push("https:" + url.pathname);
        return {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
          body: Buffer.from(
            "<rss><channel><item><title>NOAA verifies a new science report</title>" +
              "<link>https://www.noaa.gov/news/research-update</link></item></channel></rss>",
          ),
        };
      },
    },
  };
  const gated = {
    ...env,
    VNS_ALLOWED_SOURCE_HOSTS: "www.example.org,www.noaa.gov",
    VNS_FEED_RUNTIME_ENABLED: "true",
    VNS_FEED_RUNTIME_MODE: "single_pass",
    VNS_FEED_SOURCE_BOOTSTRAP: "false",
    VNS_FEED_CANARY_SOURCE_ID: "noaa_news",
    VNS_FEED_CANARY_OPERATOR_ACK: "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
  };
  const scheduler = createDormantFeedScheduler(gated, ports);
  assert.deepEqual(scheduler.sourceIds, ["noaa_news", "agency_atom", "agency_json"]);
  assert.deepEqual(await scheduler.tick(new Date(START)), [
    { sourceId: "noaa_news", status: "ingested", newItems: 1 },
  ]);
  assert.deepEqual([...f.db.keys()], ["noaa_news"]);
  assert.deepEqual(received, ["dns:www.noaa.gov", "https:/rss.xml"]);
  assert.deepEqual([...f.saved], ["noaa_news|https://www.noaa.gov/news/research-update"]);
  const auth = f.queries.filter((q) => q.sql.includes("feed_runtime_source_authorized"));
  assert.equal(auth.length, 3);
  assert.ok(auth.every((q) => JSON.parse(String(q.args[0])).id === "noaa_news"));

  const invalid = [
    { VNS_FEED_CANARY_OPERATOR_ACK: "" },
    { VNS_FEED_CANARY_SOURCE_ID: "agency_atom" },
    { VNS_FEED_RUNTIME_MODE: "persistent_worker" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
  ];
  for (const change of invalid) {
    const refused = fixture();
    assert.throws(
      () => createDormantFeedScheduler({ ...gated, ...change }, refused.ports),
      /canary gate refused/,
    );
    assert.equal(refused.readCount, 0);
    assert.equal(refused.queries.length, 0);
    assert.equal(refused.requests.length, 0);
  }

  const movedHost = [SOURCES[0]!, SOURCES[1]!, SOURCES[2]!, noaa, SOURCES[4]!];
  const movedRegistry = movedHost.map((record) =>
    record.id === "noaa_news"
      ? {
          ...record,
          baseUrl: "https://www.example.org/news/",
          feedUrl: "https://www.example.org/rss.xml",
        }
      : record,
  );
  assert.throws(
    () =>
      createDormantFeedScheduler(gated, {
        ...f.ports,
        readRegistry: () => JSON.stringify({ version: 1, sources: movedRegistry }),
      }),
    /canary denied/,
  );
});

test("USGS-only manual canary reads the exact reviewed direct RSS endpoint and no other source", async () => {
  const f = fixture();
  f.approve("usgs_news");
  const nasa = {
    ...source("nasa_news", "news/", "approved", "rss"),
    baseUrl: "https://www.nasa.gov/",
    feedUrl: "https://www.nasa.gov/rss.xml",
    termsUrl: "https://www.nasa.gov/terms/",
  };
  const noaa = {
    ...source("noaa_news", "news/", "approved", "rss"),
    baseUrl: "https://www.noaa.gov/",
    feedUrl: "https://www.noaa.gov/rss.xml",
    termsUrl: "https://www.noaa.gov/terms/",
  };
  const usgs = {
    ...source("usgs_news", "news/", "approved", "rss"),
    baseUrl: "https://www.usgs.gov/news/",
    feedUrl: "https://www.usgs.gov/news/149248/feed",
    termsUrl:
      "https://www.usgs.gov/about/organization/science-support/office-science-quality-and-integrity",
  };
  const sources = [nasa, noaa, usgs];
  const received: string[] = [];
  const ports: OfflineFeedSchedulerPorts = {
    ...f.ports,
    readRegistry: () => JSON.stringify({ version: 1, sources }),
    https: {
      resolveIPv4: async (hostname) => {
        received.push("dns:" + hostname);
        return ["1.1.1.1"];
      },
      requestPinned: async (url) => {
        received.push("https:" + url.hostname + url.pathname);
        return {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
          body: Buffer.from(
            "<rss><channel><item><title>USGS documents a new geology research finding</title>" +
              "<link>https://www.usgs.gov/news/national-news-release/example</link></item></channel></rss>",
          ),
        };
      },
    },
  };
  const gated: NodeJS.ProcessEnv = {
    ...env,
    VNS_ALLOWED_SOURCE_HOSTS: "www.nasa.gov,www.noaa.gov,www.usgs.gov",
    VNS_FEED_RUNTIME_ENABLED: "true",
    VNS_FEED_RUNTIME_MODE: "single_pass",
    VNS_FEED_SOURCE_BOOTSTRAP: "false",
    VNS_FEED_CANARY_SOURCE_ID: "usgs_news",
    VNS_FEED_CANARY_OPERATOR_ACK: "USGS_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
  };
  const scheduler = createDormantFeedScheduler(gated, ports);
  assert.deepEqual(scheduler.sourceIds, ["nasa_news", "noaa_news", "usgs_news"]);
  assert.deepEqual(await scheduler.tick(new Date(START)), [
    { sourceId: "usgs_news", status: "ingested", newItems: 1 },
  ]);
  assert.deepEqual(received, ["dns:www.usgs.gov", "https:www.usgs.gov/news/149248/feed"]);
  assert.deepEqual([...f.db.keys()], ["usgs_news"]);
  assert.deepEqual(
    [...f.saved],
    ["usgs_news|https://www.usgs.gov/news/national-news-release/example"],
  );
  const auth = f.queries.filter((q) => q.sql.includes("feed_runtime_source_authorized"));
  assert.equal(auth.length, 3);
  assert.ok(auth.every((q) => JSON.parse(String(q.args[0])).id === "usgs_news"));

  // Refuse changes to the exact personally reviewed scope and direct RSS URL
  // before any SQL claim, DNS lookup or HTTPS request.
  const invalid = [
    { baseUrl: "https://www.noaa.gov/news/" },
    { feedUrl: "https://www.usgs.gov/news/national-news-release/feed" },
    { feedUrl: "https://www.usgs.gov/news/149248/feed?preview=true" },
    { access: "official_api" },
    { usage: "full_content" },
    { status: "blocked" },
  ];
  for (const patch of invalid) {
    const denied = fixture();
    const attempted = { ...usgs, ...patch };
    assert.throws(() =>
      createDormantFeedScheduler(gated, {
        ...denied.ports,
        readRegistry: () =>
          JSON.stringify({
            version: 1,
            sources: [nasa, noaa, attempted],
          }),
      }),
    );
    assert.equal(denied.queries.length, 0);
    assert.equal(denied.requests.length, 0);
  }
});

test("NASA one-shot canary uses only the signed same-host feed endpoint", async () => {
  const f = fixture();
  f.approve("nasa_news");
  const nasa = {
    ...source("nasa_news", "news/", "approved", "rss"),
    baseUrl: "https://www.nasa.gov/news/",
    feedUrl: "https://www.nasa.gov/news-release/feed/",
    termsUrl: "https://www.nasa.gov/terms/",
  };
  const noaa = {
    ...source("noaa_news", "news/", "approved", "rss"),
    baseUrl: "https://www.noaa.gov/",
    feedUrl: "https://www.noaa.gov/rss.xml",
    termsUrl: "https://www.noaa.gov/terms/",
  };
  const usgs = {
    ...source("usgs_news", "news/", "approved", "rss"),
    baseUrl: "https://www.usgs.gov/news/",
    feedUrl: "https://www.usgs.gov/news/149248/feed",
    termsUrl: "https://www.usgs.gov/terms/",
  };
  const approved = [nasa, noaa, usgs];
  const received: string[] = [];
  const ports: OfflineFeedSchedulerPorts = {
    ...f.ports,
    readRegistry: () => JSON.stringify({ version: 1, sources: approved }),
    https: {
      resolveIPv4: async (hostname) => {
        received.push("dns:" + hostname);
        return ["1.1.1.1"];
      },
      requestPinned: async (url) => {
        received.push("https:" + url.hostname + url.pathname);
        return {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
          body: Buffer.from(
            "<rss><channel><item><title>NASA publishes an independent science bulletin</title>" +
              "<link>https://www.nasa.gov/news/science-bulletin</link></item></channel></rss>",
          ),
        };
      },
    },
  };
  const gated: NodeJS.ProcessEnv = {
    ...env,
    VNS_ALLOWED_SOURCE_HOSTS: "www.nasa.gov,www.noaa.gov,www.usgs.gov",
    VNS_FEED_RUNTIME_ENABLED: "true",
    VNS_FEED_RUNTIME_MODE: "single_pass",
    VNS_FEED_SOURCE_BOOTSTRAP: "false",
    VNS_FEED_CANARY_SOURCE_ID: "nasa_news",
    VNS_FEED_CANARY_OPERATOR_ACK: "NASA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY",
  };
  const scheduler = createDormantFeedScheduler(gated, ports);
  assert.deepEqual(scheduler.sourceIds, ["nasa_news", "noaa_news", "usgs_news"]);
  assert.deepEqual(await scheduler.tick(new Date(START)), [
    { sourceId: "nasa_news", status: "ingested", newItems: 1 },
  ]);
  assert.deepEqual(received, ["dns:www.nasa.gov", "https:www.nasa.gov/news-release/feed/"]);
  assert.deepEqual([...f.db.keys()], ["nasa_news"]);
  assert.deepEqual([...f.saved], ["nasa_news|https://www.nasa.gov/news/science-bulletin"]);
  const auth = f.queries.filter((q) => q.sql.includes("feed_runtime_source_authorized"));
  assert.equal(auth.length, 3);
  assert.ok(auth.every((q) => JSON.parse(String(q.args[0])).id === "nasa_news"));

  for (const patch of [
    { feedUrl: undefined },
    { feedUrl: "https://www.noaa.gov/rss.xml" },
    { baseUrl: "https://www.usgs.gov/news/" },
    { status: "pending" },
    { access: "official_api" },
    { usage: "reviewed_excerpt" },
  ]) {
    const denied = fixture();
    assert.throws(() =>
      createDormantFeedScheduler(gated, {
        ...denied.ports,
        readRegistry: () =>
          JSON.stringify({
            version: 1,
            sources: [{ ...nasa, ...patch }, noaa, usgs],
          }),
      }),
    );
    assert.equal(denied.queries.length, 0);
    assert.equal(denied.requests.length, 0);
  }
  const badAck = fixture();
  assert.throws(
    () =>
      createDormantFeedScheduler(
        { ...gated, VNS_FEED_CANARY_OPERATOR_ACK: "NOAA_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" },
        badAck.ports,
      ),
    /canary gate refused/,
  );
  assert.equal(badAck.queries.length, 0);
  assert.equal(badAck.requests.length, 0);

  // A refused NASA article link does not weaken SQL URL guards or commit.
  const noCanonical = fixture();
  noCanonical.approve("nasa_news");
  const refusedRequests: string[] = [];
  const refuseScheduler = createDormantFeedScheduler(gated, {
    ...noCanonical.ports,
    readRegistry: () => JSON.stringify({ version: 1, sources: approved }),
    https: {
      resolveIPv4: async (hostname) => {
        refusedRequests.push(hostname);
        return ["1.1.1.1"];
      },
      requestPinned: async () => ({
        status: 200,
        headers: { "content-type": "application/rss+xml" },
        body: Buffer.from(
          "<rss><channel><item><title>NASA bulletin must reject query links</title>" +
            "<link>https://www.nasa.gov/news/query-article?item=123</link></item></channel></rss>",
        ),
      }),
    },
  });
  assert.deepEqual(await refuseScheduler.tick(new Date(START)), [
    { sourceId: "nasa_news", status: "failed", newItems: 0 },
  ]);
  assert.deepEqual(refusedRequests, ["www.nasa.gov"]);
  assert.equal(noCanonical.saved.size, 0);
  assert.deepEqual([...noCanonical.db.keys()], ["nasa_news"]);
});
