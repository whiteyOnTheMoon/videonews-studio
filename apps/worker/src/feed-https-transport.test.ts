import assert from "node:assert/strict";
import test from "node:test";
import {
  createPinnedFeedHttpsTransport,
  type FeedHttpsDependencies,
} from "./feed-https-transport.js";
import { parseReviewedSourceRegistry } from "./source-registry.js";

const ROOT = "https://www.example.org/";
const SOURCE = {
  id: "ci_news",
  baseUrl: ROOT + "rss/",
  status: "approved",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: ROOT + "terms/",
  usage: "metadata_only",
  licenseNotes: "Only reviewed metadata is allowed to be cited.",
  reviewedAt: "2026-10-26",
};
const POLICY = { enabled: true as const, hosts: ["www.example.org"] };
const feed =
  "<rss><channel><item><title>Transport funding announcement</title>" +
  "<link>https://www.example.org/rss/transport-1</link></item></channel></rss>";
const good = {
  status: 200,
  headers: { "content-type": "application/rss+xml", etag: '"version-1"' },
  body: Buffer.from(feed),
};
const registry = () =>
  parseReviewedSourceRegistry(JSON.stringify({ version: 1, sources: [SOURCE] }), POLICY);

function deps(overrides: Partial<FeedHttpsDependencies> = {}) {
  const calls: Array<{ url: URL; ip: string; headers: Record<string, string> }> = [];
  const values: FeedHttpsDependencies = {
    async resolveIPv4(host) {
      assert.equal(host, "www.example.org");
      return ["1.1.1.1"];
    },
    async requestPinned(url, ip, headers) {
      calls.push({ url, ip, headers });
      return good;
    },
    ...overrides,
  };
  return { calls, values };
}

test("approved pinned transport supports conditional 200/304 without external DNS", async () => {
  const state = deps();
  const source = registry()[0]!;
  const transport = createPinnedFeedHttpsTransport(registry(), POLICY, state.values);
  assert.deepEqual(
    await transport.request(source, {
      etag: '"old"',
      lastModified: "Sun, 25 Oct 2026 10:00:00 GMT",
    }),
    {
      status: 200,
      mediaType: "application/rss+xml",
      body: feed,
      etag: '"version-1"',
      lastModified: null,
    },
  );
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0]?.ip, "1.1.1.1");
  assert.equal(state.calls[0]?.url.toString(), ROOT + "rss/");
  assert.deepEqual(state.calls[0]?.headers, {
    "If-None-Match": '"old"',
    "If-Modified-Since": "Sun, 25 Oct 2026 10:00:00 GMT",
  });
  const cached = deps({
    requestPinned: async () => ({
      status: 304,
      headers: { etag: '"version-1"' },
      body: Buffer.alloc(0),
    }),
  });
  assert.deepEqual(
    await createPinnedFeedHttpsTransport(registry(), POLICY, cached.values).request(source, {
      etag: '"version-1"',
      lastModified: null,
    }),
    {
      status: 304,
      mediaType: null,
      body: "",
      etag: '"version-1"',
      lastModified: null,
    },
  );
});

test("pending, blocked, unreviewed and forged registry entries cannot reach DNS", async () => {
  let attempted = 0;
  const state = deps({
    resolveIPv4: async () => {
      attempted++;
      return ["1.1.1.1"];
    },
  });
  const registryItems = registry();
  const transport = createPinnedFeedHttpsTransport(registryItems, POLICY, state.values);
  for (const forged of [
    { ...registryItems[0]!, status: "pending" as const },
    { ...registryItems[0]!, status: "blocked" as const },
    { ...registryItems[0]!, baseUrl: "https://www.example.org/private/" },
    { ...registryItems[0]!, id: "other_news" },
    { ...registryItems[0]!, access: "official_api" as const },
  ]) {
    await assert.rejects(
      transport.request(forged, { etag: null, lastModified: null }),
      /not approved/,
    );
  }
  assert.equal(attempted, 0);
  assert.equal(state.calls.length, 0);
});

test("private DNS, mixed-address answers and dangerous conditional headers are rejected", async () => {
  const src = registry()[0]!;
  for (const addresses of [
    ["127.0.0.1"],
    ["1.1.1.1", "10.0.0.1"],
    [],
    ["::1"],
    Array.from({ length: 17 }, () => "1.1.1.1"),
  ]) {
    const state = deps({ resolveIPv4: async () => addresses });
    await assert.rejects(
      createPinnedFeedHttpsTransport(registry(), POLICY, state.values).request(src, {
        etag: null,
        lastModified: null,
      }),
      /DNS address refused/,
    );
    assert.equal(state.calls.length, 0);
  }
  let calls = 0;
  const guarded = createPinnedFeedHttpsTransport(registry(), POLICY, {
    resolveIPv4: async () => {
      calls++;
      return ["1.1.1.1"];
    },
    requestPinned: async () => good,
  });
  for (const etag of ["a\r\nB: forged", "x".repeat(201), "a\nnewline"]) {
    await assert.rejects(guarded.request(src, { etag, lastModified: null }));
  }
  assert.equal(calls, 0);
});

test("redirects, compression, oversized bytes, invalid UTF-8 and MIME types fail closed", async () => {
  const src = registry()[0]!;
  const failures = [
    { ...good, status: 302 },
    { ...good, status: 404 },
    { ...good, headers: { ...good.headers, "content-encoding": "gzip" } },
    { ...good, headers: { ...good.headers, "content-type": "text/html" } },
    { ...good, headers: { ...good.headers, "content-length": "1" } },
    { ...good, headers: { ...good.headers, "content-length": "0001" } },
    { ...good, headers: { ...good.headers, etag: "bad\r\nHeader" } },
    { ...good, body: Buffer.alloc(131073) },
    { ...good, body: Buffer.from([0xff, 0xfe]) },
    { ...good, status: 304, body: Buffer.from("unexpected") },
  ];
  for (const response of failures) {
    const transport = createPinnedFeedHttpsTransport(
      registry(),
      POLICY,
      deps({ requestPinned: async () => response }).values,
    );
    await assert.rejects(transport.request(src, { etag: null, lastModified: null }));
  }
});

test("DNS and HTTPS exceptions are redacted and never retried automatically", async () => {
  const src = registry()[0]!;
  const failures: Array<Partial<FeedHttpsDependencies>> = [
    {
      resolveIPv4: async () => {
        throw new Error("private-dns-key");
      },
    },
    {
      requestPinned: async () => {
        throw new Error("secret-in-response");
      },
    },
  ];
  for (const injected of failures) {
    let called = 0;
    const opts = deps({
      async resolveIPv4(host) {
        called++;
        if (injected.resolveIPv4) return injected.resolveIPv4(host);
        return ["1.1.1.1"];
      },
      async requestPinned(url, ip, headers) {
        called++;
        if (injected.requestPinned) return injected.requestPinned(url, ip, headers);
        return good;
      },
    });
    await assert.rejects(
      createPinnedFeedHttpsTransport(registry(), POLICY, opts.values).request(src, {
        etag: null,
        lastModified: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("private"), false);
        assert.equal(error.message.includes("secret"), false);
        return true;
      },
    );
    assert.ok(called <= 2);
  }
});
