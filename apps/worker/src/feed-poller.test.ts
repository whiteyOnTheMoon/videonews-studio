import assert from "node:assert/strict";
import test from "node:test";
import {
  createDormantFeedPoller,
  decodeApprovedFeed,
  type FeedItem,
  type FeedPollStore,
  type FeedResponse,
  type FeedTransport,
  type FeedValidators,
} from "./feed-poller.js";
import { parseReviewedSourceRegistry } from "./source-registry.js";

const prefix = "https://www.example.org/";
const policy = { enabled: true as const, hosts: ["www.example.org"] };
const at = (minutes: number) => new Date(1761446400000 + minutes * 60000);
function source(
  id: string,
  scope: string,
  status: "approved" | "blocked" | "pending",
  access: "rss" | "atom" | "official_api",
) {
  return {
    id,
    baseUrl: prefix + scope,
    status,
    access,
    intervalMinutes: 60,
    termsUrl: prefix + "terms/",
    usage: "metadata_only",
    licenseNotes: "Metadata use only after independent editorial review.",
    reviewedAt: "2026-10-26",
  };
}
const records = [
  source("feed_rss", "rss/", "approved", "rss"),
  source("feed_atom", "atom/", "approved", "atom"),
  source("feed_api", "api/", "approved", "official_api"),
  source("feed_blocked", "blocked/", "blocked", "rss"),
  source("feed_pending", "pending/", "pending", "rss"),
];
const registry = () =>
  parseReviewedSourceRegistry(JSON.stringify({ version: 1, sources: records }), policy);
const rssBody =
  '<rss version="2.0"><channel>' +
  "<item><title>Regional bus funding announced</title><link>" +
  prefix +
  "rss/news-1</link><pubDate>Sun, 25 Oct 2026 09:00:00 GMT</pubDate></item>" +
  "<item><title>Regional bus funding announced</title><link>" +
  prefix +
  "rss/news-1</link></item>" +
  "<item><title>Blocked candidate must be ignored</title><link>" +
  prefix +
  "blocked/no</link></item></channel></rss>";
const atomBody =
  '<feed xmlns="http://www.w3.org/2005/Atom"><entry>' +
  '<title>Regional railway policy adopted</title><link href="' +
  prefix +
  'atom/news-2" rel="alternate" />' +
  "<updated>2026-10-25T12:00:00Z</updated></entry></feed>";
const apiBody = JSON.stringify({
  items: [
    {
      url: prefix + "api/news-3",
      headline: "City publishes transport strategy",
      publishedAt: "2026-10-25T12:00:00Z",
    },
  ],
});
const rss: FeedResponse = {
  status: 200,
  mediaType: "application/rss+xml",
  body: rssBody,
  etag: '"rss-v1"',
  lastModified: "Sun, 25 Oct 2026 12:00:00 GMT",
};
const atom: FeedResponse = {
  status: 200,
  mediaType: "application/atom+xml",
  body: atomBody,
  etag: '"atom-v1"',
  lastModified: null,
};
const api: FeedResponse = {
  status: 200,
  mediaType: "application/json",
  body: apiBody,
  etag: '"api-v1"',
  lastModified: null,
};

function fixture() {
  const claims = new Map<string, { until: number; validators: FeedValidators }>();
  const items = new Map<string, FeedItem>();
  const requested: Array<{ id: string; validators: FeedValidators }> = [];
  const responses: Record<string, FeedResponse> = {
    feed_rss: rss,
    feed_atom: atom,
    feed_api: api,
  };
  const store: FeedPollStore = {
    async claim(id, now, minutes) {
      const existing = claims.get(id);
      if (existing && now.getTime() < existing.until) return null;
      claims.set(id, {
        until: now.getTime() + minutes * 60000,
        validators: existing?.validators ?? { etag: null, lastModified: null },
      });
      return {
        token: "11111111-2222-4333-8444-555555555555",
        validators: claims.get(id)!.validators,
      };
    },
    async commit(id, token, additions, validators) {
      assert.equal(token, "11111111-2222-4333-8444-555555555555");
      let created = 0;
      for (const item of additions) {
        assert.equal(item.reviewStatus, "candidate");
        const key = id + "|" + item.url;
        if (!items.has(key)) {
          items.set(key, item);
          created++;
        }
      }
      claims.get(id)!.validators = validators;
      return created;
    },
  };
  const transport: FeedTransport = {
    async request(src, validators) {
      requested.push({ id: src.id, validators });
      const response = responses[src.id];
      if (!response) throw new Error("Network call to unapproved source");
      return response;
    },
  };
  return { store, transport, claims, items, requested, responses };
}

test("approved feeds poll with ETags and an enforced minimum interval", async () => {
  const f = fixture();
  const poller = createDormantFeedPoller(registry(), true, f.store, f.transport);
  assert.deepEqual(await poller.poll(at(0)), [
    { sourceId: "feed_rss", status: "ingested", newItems: 1 },
    { sourceId: "feed_atom", status: "ingested", newItems: 1 },
    { sourceId: "feed_api", status: "ingested", newItems: 1 },
  ]);
  assert.deepEqual(
    f.requested.map((x) => x.id),
    ["feed_rss", "feed_atom", "feed_api"],
  );
  assert.equal(f.items.size, 3);
  assert.deepEqual(await poller.poll(at(59)), []);
  for (const id of ["feed_rss", "feed_atom", "feed_api"]) {
    f.responses[id] = {
      status: 304,
      mediaType: null,
      body: "",
      etag: null,
      lastModified: null,
    };
  }
  assert.ok((await poller.poll(at(60))).every((x) => x.status === "not_modified"));
  assert.deepEqual(
    f.requested.slice(3).map((x) => x.validators.etag),
    ['"rss-v1"', '"atom-v1"', '"api-v1"'],
  );
  f.responses.feed_rss = rss;
  f.responses.feed_atom = atom;
  f.responses.feed_api = api;
  assert.ok((await poller.poll(at(120))).every((x) => x.newItems === 0));
  assert.equal(f.items.size, 3);
});

test("unknown and blocked sources never trigger a transport call", async () => {
  const f = fixture();
  assert.throws(
    () => createDormantFeedPoller(registry(), false, f.store, f.transport),
    /explicit offline authorization/,
  );
  assert.throws(
    () => createDormantFeedPoller(registry().slice(0, 2), true, f.store, f.transport),
    /three to five reviewed sources/,
  );
  assert.throws(
    () =>
      createDormantFeedPoller(
        registry().map((src) => ({ ...src, status: "pending" as const })),
        true,
        f.store,
        f.transport,
      ),
    /three to five reviewed sources/,
  );
  assert.equal(f.requested.length, 0);
  await assert.rejects(
    createDormantFeedPoller(registry(), true, f.store, f.transport).poll(new Date("invalid")),
    /clock invalid/,
  );
});

test("RSS metadata is deduplicated and blocked article scopes are excluded", () => {
  const sources = registry();
  const entries = decodeApprovedFeed(sources[0]!, sources, rss);
  assert.deepEqual(entries, [
    {
      sourceId: "feed_rss",
      url: prefix + "rss/news-1",
      headline: "Regional bus funding announced",
      publishedAt: "2026-10-25T09:00:00.000Z",
      reviewStatus: "candidate",
    },
  ]);
  assert.equal(JSON.stringify(entries).includes("Blocked candidate"), false);
  assert.equal(JSON.stringify(entries).includes("description"), false);
});

test("unsafe XML, invalid media, and unbounded feeds fail closed", () => {
  const sources = registry();
  const src = sources[0]!;
  for (const body of [
    '<!DOCTYPE rss [<!ENTITY external SYSTEM "file:///etc/passwd">]>' + rssBody,
    "<rss><item><title>Bad metadata entry</title></item></rss>",
    "<rss><channel><item><title>Broken entry</title></channel></rss>",
    "<feed><entry><title>Wrong feed type</title></entry></feed>",
  ]) {
    assert.throws(() => decodeApprovedFeed(src, sources, { ...rss, body }));
  }
  assert.throws(() => decodeApprovedFeed(src, sources, { ...rss, mediaType: "text/html" }));
  assert.throws(() => decodeApprovedFeed(src, sources, { ...rss, body: "x".repeat(131073) }));
  assert.throws(() =>
    decodeApprovedFeed(src, sources, {
      ...rss,
      body: "<rss>" + "<item><title>Some headline here</title></item>".repeat(21) + "</rss>",
    }),
  );
});

test("transport failure is sanitized and still consumes the polling interval", async () => {
  const f = fixture();
  const failed: FeedTransport = {
    async request(src, validators) {
      if (src.id === "feed_rss") throw new Error("private source token");
      return f.transport.request(src, validators);
    },
  };
  const poller = createDormantFeedPoller(registry(), true, f.store, failed);
  const result = await poller.poll(at(0));
  assert.equal(result[0]?.status, "failed");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.deepEqual(await poller.poll(at(1)), []);
});
