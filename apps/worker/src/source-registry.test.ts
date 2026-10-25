import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "bullmq";
import { parseApprovedResearchCatalog } from "./research-catalog.js";
import { createResearchProcessor } from "./research-process.js";
import {
  approvedSourceForUrl,
  createReviewedCatalogDiscovery,
  parseReviewedSourceRegistry,
} from "./source-registry.js";

const HOST = "www.example.org";
const POLICY = { enabled: true as const, hosts: [HOST] };
const TOPIC = "Local government investment in regional transport";
const APPROVED_URL = "https://www.example.org/news/transport-report";
const BLOCKED_URL = "https://www.example.org/news/blocked/sensitive-item";
const PENDING_URL = "https://www.example.org/drafts/unapproved";
const CANDIDATE = {
  sourceUrl: APPROVED_URL,
  publisher: "Fictional Public Agency",
  headline: "Annual transport investment statement",
  claim: "The agency released its annual transport investment report.",
};

function entry(
  id: string,
  baseUrl: string,
  status: "approved" | "pending" | "blocked",
) {
  return {
    id,
    baseUrl,
    status,
    access: "rss",
    intervalMinutes: 60,
    termsUrl: "https://www.example.org/terms/",
    usage: "metadata_only",
    licenseNotes: "Metadata citation only; no full-text reuse.",
    reviewedAt: "2026-10-26",
  };
}

const entries = [
  entry("agency_news", "https://www.example.org/news/", "approved"),
  entry("agency_blocked", "https://www.example.org/news/blocked/", "blocked"),
  entry("agency_drafts", "https://www.example.org/drafts/", "pending"),
];
const json = (sources: unknown[]) => JSON.stringify({ version: 1, sources });
const registry = () => parseReviewedSourceRegistry(json(entries), POLICY);

test("registry requires reviewed rights and polling metadata", () => {
  const records = registry();
  assert.equal(records.length, 3);
  assert.equal(records[0]?.access, "rss");
  assert.equal(records[0]?.intervalMinutes, 60);
  assert.equal(records[0]?.usage, "metadata_only");
  assert.equal(records[0]?.termsUrl, "https://www.example.org/terms/");
  assert.equal(records[0]?.reviewedAt, "2026-10-26");
});

test("longest path scope enforces a blocked child over an approved parent", () => {
  const records = registry();
  assert.equal(approvedSourceForUrl(APPROVED_URL, records)?.id, "agency_news");
  for (const denied of [
    BLOCKED_URL,
    PENDING_URL,
    "https://www.example.org/newsroom/unsafe",
    "https://other.example.org/news/story",
    "http://www.example.org/news/story",
    "https://www.example.org/news/%2e%2e/private",
    "https://www.example.org/news/%2fprivate",
  ]) {
    assert.equal(approvedSourceForUrl(denied, records), null, denied);
  }
});

test("rejects unreviewed registry data, permissive wildcard and unsafe URLs", () => {
  const good = entries[0]!;
  const broken: unknown[] = [
    "",
    "{}",
    "not json",
    JSON.stringify({ version: 2, sources: entries }),
    json([]),
    json([good, good]),
    json([
      { ...good, id: "unknown" },
      { ...good, id: "unknown", baseUrl: PENDING_URL + "/" },
    ]),
    json([{ ...good, status: "trusted" }]),
    json([{ ...good, licenseNotes: "" }]),
    json([{ ...good, termsUrl: "http://www.example.org/terms/" }]),
    json([{ ...good, intervalMinutes: 0 }]),
    json([{ ...good, intervalMinutes: 10.5 }]),
    json([{ ...good, reviewedAt: "2026-02-30" }]),
    json([{ ...good, extra: true }]),
    json([{ ...good, baseUrl: "https://www.example.org/newsroom" }]),
    json([{ ...good, baseUrl: "https://www.example.org/news/%2f/" }]),
    json([{ ...good, baseUrl: "https://localhost/news/" }]),
    json(entries) + " ".repeat(33000),
  ];
  for (const input of broken) {
    assert.throws(
      () => parseReviewedSourceRegistry(input as string, POLICY),
      /Reviewed source/,
      String(input).slice(0, 70),
    );
  }
  assert.throws(
    () =>
      parseReviewedSourceRegistry(json(entries), {
        enabled: true,
        hosts: ["other.example.org"],
      }),
    /scope invalid/,
  );
});

test("unapproved candidates are excluded before a research processor can fetch", async () => {
  const catalog = parseApprovedResearchCatalog(
    JSON.stringify({
      version: 1,
      topics: [
        {
          topic: TOPIC,
          candidates: [
            CANDIDATE,
            { ...CANDIDATE, sourceUrl: BLOCKED_URL },
            { ...CANDIDATE, sourceUrl: PENDING_URL },
          ],
        },
      ],
    }),
    POLICY,
  );
  const discovery = createReviewedCatalogDiscovery(catalog, registry());
  assert.deepEqual(await discovery.discover(TOPIC), [CANDIDATE]);

  const id = "60a429e9-72ce-46e2-919a-8d99e52677a9";
  const job = {
    id: "job-" + id.replaceAll("-", ""),
    name: "research",
    data: { kind: "research", jobId: id },
  } as unknown as Job;
  const fetched: string[] = [];
  const recorded: string[] = [];
  const process = createResearchProcessor(
    {
      async loadResearchTopic() {
        return TOPIC;
      },
      async saveCandidate(id, candidate) {
        void id;
        recorded.push(candidate.sourceUrl);
      },
    },
    discovery,
    {
      async fetch(url) {
        fetched.push(url);
        return {
          sourceUrl: url,
          fetchedAt: "2026-10-26T12:00:00.000Z",
          mediaType: "text/html",
          sha256: "a".repeat(64),
          text: "Synthetic response, no network request",
        };
      },
    },
  );
  assert.deepEqual(await process(job), {
    candidatesRecorded: 1,
    needsEditorialReview: true,
  });
  assert.deepEqual(fetched, [APPROVED_URL]);
  assert.deepEqual(recorded, [APPROVED_URL]);
});

test("topic containing only rejected sources cannot trigger any retrieval", async () => {
  const catalog = parseApprovedResearchCatalog(
    JSON.stringify({
      version: 1,
      topics: [
        {
          topic: TOPIC,
          candidates: [{ ...CANDIDATE, sourceUrl: BLOCKED_URL }],
        },
      ],
    }),
    POLICY,
  );
  const discovery = createReviewedCatalogDiscovery(catalog, registry());
  await assert.rejects(discovery.discover(TOPIC), /No approved research sources/);
  await assert.rejects(
    discovery.discover("Unrecognized topic for testing"),
    /not operator approved/,
  );
});
