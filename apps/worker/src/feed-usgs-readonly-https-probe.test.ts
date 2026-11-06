import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { probeUsGsOneGet } from "./feed-usgs-readonly-https-probe.js";
import { prepareDormantSourceExport } from "./source-registry-export.js";
import { sealDormantSourceExport } from "./source-export-signature.js";
import type { FeedHttpsDependencies } from "./feed-https-transport.js";

const HOSTS = ["www.nasa.gov", "www.noaa.gov", "www.usgs.gov"];
const env: NodeJS.ProcessEnv = {
  VNS_P2_USGS_GET_DIAGNOSTIC_ENABLED: "true",
  VNS_P2_USGS_GET_DIAGNOSTIC_ACK: "ONE_READ_ONLY_USGS_HTTPS_GET_DIAGNOSTIC_ONLY",
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: HOSTS.join(","),
};
const source = (id: string, baseUrl: string, feedUrl: string) => ({
  id,
  baseUrl,
  feedUrl,
  access: "rss" as const,
  status: "approved" as const,
  intervalMinutes: 60,
  termsUrl: baseUrl + "terms/",
  usage: "metadata_only" as const,
  licenseNotes: "Synthetic metadata-only test fixture with reviewed rights.",
  reviewedAt: "2026-11-06",
});
const sources = [
  source("nasa_news", "https://www.nasa.gov/news/", "https://www.nasa.gov/news/rss"),
  source("noaa_news", "https://www.noaa.gov/news/", "https://www.noaa.gov/news/rss"),
  source("usgs_news", "https://www.usgs.gov/news/", "https://www.usgs.gov/news/149248/feed"),
];
const keys = generateKeyPairSync("ed25519");
function fixture(input = sources) {
  const bundle = prepareDormantSourceExport(
    { revision: 10, sources: input },
    { revision: 10, approvedHosts: HOSTS },
  );
  const signed = JSON.stringify(
    sealDormantSourceExport(bundle, { enabled: true, hosts: HOSTS }, keys.privateKey),
  );
  const checkpoint = JSON.stringify({
    version: 1,
    sourceRevision: 10,
    hostApprovalRevision: 10,
    envelopeSha256: createHash("sha256").update(signed).digest("hex"),
  });
  return { signed, checkpoint };
}
const approved = fixture();
const rss =
  "<rss><channel><item><title>Official geological survey announcement</title>" +
  "<link>https://www.usgs.gov/news/official-geological-survey-announcement</link>" +
  "</item></channel></rss>";

test("exactly one signed USGS GET; neither NASA nor NOAA contacted", async () => {
  const urls: string[] = [];
  const ports: Partial<FeedHttpsDependencies> = {
    async resolveIPv4(host) {
      assert.equal(host, "www.usgs.gov");
      return ["1.1.1.1"];
    },
    async requestPinned(url, ip, headers) {
      urls.push(url.toString());
      assert.equal(ip, "1.1.1.1");
      assert.deepEqual(headers, {});
      return {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
        body: Buffer.from(rss),
      };
    },
  };
  const result = await probeUsGsOneGet(
    env,
    approved.signed,
    approved.checkpoint,
    keys.publicKey,
    ports,
  );
  assert.deepEqual(urls, ["https://www.usgs.gov/news/149248/feed"]);
  assert.deepEqual(result, {
    scope: "usgs_single_readonly_get",
    sourceId: "usgs_news",
    stage: "metadata_accepted",
    approvedArticleUrls: 1,
  });
});

test("wrong or missing operator gate rejects before DNS or HTTP", async () => {
  let requests = 0;
  const ports: Partial<FeedHttpsDependencies> = {
    async resolveIPv4() {
      requests++;
      return ["1.1.1.1"];
    },
  };
  for (const change of [
    { VNS_P2_USGS_GET_DIAGNOSTIC_ENABLED: "false" },
    { VNS_P2_USGS_GET_DIAGNOSTIC_ACK: "" },
    { VNS_P2_USGS_GET_DIAGNOSTIC_ACK: "USGS_SINGLE_SOURCE_PERSISTENCE_CANARY_ONLY" },
    { VNS_SOURCE_FETCH_ENABLED: "false" },
    { VNS_ALLOWED_SOURCE_HOSTS: "www.usgs.gov" },
    { VNS_FEED_RUNTIME_ENABLED: "true" },
    { VNS_FEED_CANARY_SOURCE_ID: "usgs_news" },
    { VNS_FEED_SOURCE_BOOTSTRAP: "true" },
  ]) {
    await assert.rejects(
      probeUsGsOneGet(
        { ...env, ...change },
        approved.signed,
        approved.checkpoint,
        keys.publicKey,
        ports,
      ),
    );
  }
  assert.equal(requests, 0);
});

test("signature, checkpoint and exact USGS endpoint fail closed before DNS", async () => {
  let dns = 0;
  const ports: Partial<FeedHttpsDependencies> = {
    async resolveIPv4() {
      dns++;
      return ["1.1.1.1"];
    },
  };
  const alteredSigned = approved.signed.replace("149248", "149249");
  const wrong = fixture(
    sources.map((entry) =>
      entry.id === "usgs_news"
        ? { ...entry, feedUrl: "https://www.usgs.gov/news/other/feed" }
        : entry,
    ),
  );
  const otherKey = generateKeyPairSync("ed25519");
  for (const [signed, checkpoint, key] of [
    [alteredSigned, approved.checkpoint, keys.publicKey],
    [approved.signed, approved.checkpoint, otherKey.publicKey],
    [
      approved.signed,
      JSON.stringify({ ...JSON.parse(approved.checkpoint), sourceRevision: 9 }),
      keys.publicKey,
    ],
    [wrong.signed, wrong.checkpoint, keys.publicKey],
  ] as const) {
    await assert.rejects(probeUsGsOneGet(env, signed, checkpoint, key, ports));
  }
  assert.equal(dns, 0);
});

test("denied HTTP and DNS error disclose only fixed classification", async () => {
  const refused = await probeUsGsOneGet(env, approved.signed, approved.checkpoint, keys.publicKey, {
    resolveIPv4: async () => ["1.1.1.1"],
    requestPinned: async () => ({
      status: 403,
      headers: { "content-type": "text/html" },
      body: Buffer.from("PRIVATE_UPSTREAM_BODY"),
    }),
  });
  assert.deepEqual(refused, {
    scope: "usgs_single_readonly_get",
    sourceId: "usgs_news",
    stage: "https_or_http_refused",
    refusal: "http_status_refused",
    httpStatus: 403,
  });
  const failed = await probeUsGsOneGet(env, approved.signed, approved.checkpoint, keys.publicKey, {
    resolveIPv4: async () => {
      throw new Error("PRIVATE_DNS_DATA");
    },
  });
  assert.deepEqual(failed, {
    scope: "usgs_single_readonly_get",
    sourceId: "usgs_news",
    stage: "https_or_http_refused",
    refusal: "dns_unavailable",
  });
  assert.equal(JSON.stringify([refused, failed]).includes("PRIVATE"), false);
});
