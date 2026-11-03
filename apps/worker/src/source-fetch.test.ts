import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import https from "node:https";
import { createServer } from "node:net";
import test from "node:test";
import {
  createPinnedHttpsOptions,
  fetchApprovedSourceDocument,
  isPublicIPv4,
  readApprovedFetchPolicy,
  type SourceFetchDependencies,
} from "./source-fetch.js";

const SOURCE = "https://www.example.org/news/transport?year=2026";
const HOST = "www.example.org";
const GOOD_IP = "1.1.1.1";
const POLICY = { enabled: true as const, hosts: [HOST] };
const text = "<article>Unverified example for isolated tests only.</article>";
const response = {
  status: 200,
  contentType: "text/html; charset=utf-8",
  contentEncoding: undefined,
  body: Buffer.from(text),
};

function mock(overrides: Partial<SourceFetchDependencies> = {}): SourceFetchDependencies {
  return {
    resolveIPv4: async (host) => {
      assert.equal(host, HOST);
      return [GOOD_IP];
    },
    requestPinned: async (url, address) => {
      assert.equal(url.hostname, HOST);
      assert.equal(url.pathname, "/news/transport");
      assert.equal(url.search, "?year=2026");
      assert.equal(address, GOOD_IP);
      return response;
    },
    now: () => new Date("2026-10-23T15:20:00.000Z"),
    ...overrides,
  };
}

test("only explicit per-host opt-in permits fetching", () => {
  assert.throws(() => readApprovedFetchPolicy({}), /disabled/);
  assert.throws(
    () =>
      readApprovedFetchPolicy({
        VNS_SOURCE_FETCH_ENABLED: "true",
      }),
    /allowlist/,
  );
  assert.throws(
    () =>
      readApprovedFetchPolicy({
        VNS_SOURCE_FETCH_ENABLED: "true",
        VNS_ALLOWED_SOURCE_HOSTS: "www.example.org,localhost",
      }),
    /allowlist/,
  );
  assert.throws(
    () =>
      readApprovedFetchPolicy({
        VNS_SOURCE_FETCH_ENABLED: "true",
        VNS_ALLOWED_SOURCE_HOSTS: "www.example.org,www.example.org",
      }),
    /allowlist/,
  );
  assert.deepEqual(
    readApprovedFetchPolicy({
      VNS_SOURCE_FETCH_ENABLED: "true",
      VNS_ALLOWED_SOURCE_HOSTS: "www.example.org",
    }),
    POLICY,
  );
});

test("rejects loopback, link local, LAN, CGNAT, reserved and IPv6 targets", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "192.168.1.1",
    "172.16.1.2",
    "100.64.0.1",
    "169.254.169.254",
    "0.1.2.3",
    "255.1.2.3",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "1.2.3.999",
    "172.31.255.255",
  ])
    assert.equal(isPublicIPv4(ip), false, ip);
  assert.equal(isPublicIPv4(GOOD_IP), true);
  assert.equal(isPublicIPv4("8.8.8.8"), true);
  // NASA's public 192.0.66.x CDN address must not be confused with
  // 192.0.0.0/24 or the 192.0.2.0/24 TEST-NET-1 reservation.
  assert.equal(isPublicIPv4("192.0.66.108"), true);
  assert.equal(isPublicIPv4("192.0.0.1"), false);
  assert.equal(isPublicIPv4("192.0.2.1"), false);
});

test("allowlisting precedes DNS resolution and even mock network calls", async () => {
  let called = 0;
  const deps = mock({
    resolveIPv4: async () => {
      called += 1;
      return [GOOD_IP];
    },
    requestPinned: async () => {
      called += 1;
      return response;
    },
  });
  for (const url of [
    "https://api.example.org/news",
    "http://www.example.org/news",
    "https://127.0.0.1/private",
    "https://www.example.org:8443/news",
    "https://admin:www@www.example.org/news",
    "https://www.example.org/news#chapter",
    "https://www.example.org",
  ]) {
    await assert.rejects(fetchApprovedSourceDocument(url, POLICY, deps));
  }
  assert.equal(called, 0);
});

test("DNS must contain exclusively public IPv4; no fallback to an unsafe address", async () => {
  for (const addresses of [
    [],
    ["127.0.0.1"],
    [GOOD_IP, "10.0.0.1"],
    ["::1"],
    Array.from({ length: 17 }, () => GOOD_IP),
  ]) {
    let requests = 0;
    await assert.rejects(
      fetchApprovedSourceDocument(
        SOURCE,
        POLICY,
        mock({
          resolveIPv4: async () => addresses,
          requestPinned: async () => {
            requests += 1;
            return response;
          },
        }),
      ),
      /forbidden/,
    );
    assert.equal(requests, 0);
  }
});

test("TLS request pins checked IP while retaining approved SNI and Host", async () => {
  const opts = createPinnedHttpsOptions(new URL(SOURCE), GOOD_IP);
  assert.equal(opts.hostname, HOST);
  assert.equal(opts.servername, HOST);
  assert.equal(opts.agent, false);
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(opts.port, 443);
  assert.equal(opts.method, "GET");
  assert.equal(opts.path, "/news/transport?year=2026");
  assert.equal((opts.headers as Record<string, string>).Host, HOST);
  assert.equal((opts.headers as Record<string, string>)["Accept-Encoding"], "identity");
  assert.equal(opts.timeout, 5000);
  assert.ok(opts.signal instanceof AbortSignal);
  assert.equal(opts.signal.aborted, false);
  assert.equal(opts.maxHeaderSize, 8192);
  assert.ok(opts.lookup);
  await new Promise<void>((resolve, reject) => {
    // Invoke only the generated lookup closure; no actual DNS or HTTPS I/O.
    opts.lookup?.(HOST, {}, (error, ip) => {
      if (error) reject(error);
      else {
        assert.equal(ip, GOOD_IP);
        resolve();
      }
    });
  });
});

test("Node 22 lookup-all mode returns only the previously approved pinned IPv4", async () => {
  const opts = createPinnedHttpsOptions(new URL(SOURCE), GOOD_IP);
  await new Promise<void>((resolve, reject) => {
    opts.lookup?.(HOST, { all: true }, (error, addresses) => {
      if (error) return reject(error);
      try {
        assert.deepEqual(addresses, [{ address: GOOD_IP, family: 4 }]);
        resolve();
      } catch (assertion) {
        reject(assertion);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    opts.lookup?.("unapproved.example.org", { all: true }, (error) => {
      try {
        assert.match(error?.message ?? "", /Unexpected DNS hostname/);
        resolve();
      } catch (assertion) {
        reject(assertion);
      }
    });
  });
});

test("Node 22 HTTPS reaches the pinned socket with lookup-all (loopback only)", async () => {
  // The local test socket is deliberately injected AFTER the public-IP policy
  // boundary; this does not permit private addresses in production.
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy(); // Close fully; no TLS or HTTP response.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const bound = server.address();
    assert.ok(bound && typeof bound === "object");
    const options = {
      ...createPinnedHttpsOptions(new URL(SOURCE), "127.0.0.1"),
      port: bound.port,
      method: "HEAD",
      autoSelectFamily: true,
      signal: AbortSignal.timeout(1500),
    };
    const failure = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const request = https.request(options, (response) => {
        response.resume();
        reject(new Error("Unexpected HTTPS response from test TCP server"));
      });
      request.once("error", resolve);
      request.end();
    });
    assert.notEqual(failure.code, "ERR_INVALID_IP_ADDRESS");
    assert.notEqual(failure.code, "ABORT_ERR");
    assert.equal(connections, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("returns bounded content digest, never marks a retrieved article verified", async () => {
  const actual = await fetchApprovedSourceDocument(SOURCE, POLICY, mock());
  assert.deepEqual(actual, {
    sourceUrl: SOURCE,
    mediaType: "text/html",
    text,
    fetchedAt: "2026-10-23T15:20:00.000Z",
    sha256: createHash("sha256").update(Buffer.from(text)).digest("hex"),
  });
  assert.equal("verified" in actual, false);
  assert.equal("reviewStatus" in actual, false);
});

test("never follows redirects and rejects gzip, oversized or non-text responses", async () => {
  for (const bad of [
    { ...response, status: 301 },
    { ...response, status: 404 },
    { ...response, contentEncoding: "gzip" },
    { ...response, contentType: "application/octet-stream" },
    { ...response, contentType: undefined },
    { ...response, body: Buffer.alloc(131073) },
    { ...response, body: Buffer.from([0xff, 0xff]) },
  ]) {
    await assert.rejects(
      fetchApprovedSourceDocument(
        SOURCE,
        POLICY,
        mock({
          requestPinned: async () => bad,
        }),
      ),
    );
  }
});

test("upstream transport exceptions are sanitized and no request is retried", async () => {
  let requests = 0;
  await assert.rejects(
    fetchApprovedSourceDocument(
      SOURCE,
      POLICY,
      mock({
        requestPinned: async () => {
          requests += 1;
          throw new Error("TOP_SECRET_IN_URL");
        },
      }),
    ),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.ok(!(error as Error).message.includes("TOP_SECRET"));
      return true;
    },
  );
  assert.equal(requests, 1);
});
