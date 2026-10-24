import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "bullmq";
import {
  createResearchProcessor,
  type ResearchEvidenceStore,
  type ResearchCandidateProvider,
  type ResearchFetchPort,
} from "./research-process.js";
import type { SourceCandidate } from "./source-policy.js";

const ID = "60a429e9-72ce-46e2-919a-8d99e52677a9";
const QUEUE_ID = "job-" + ID.replaceAll("-", "");
const TOPIC = "Regional mobility investment and infrastructure research";
const SOURCE = "https://www.example.org/articles/public-transport";
const candidate = {
  sourceUrl: SOURCE,
  publisher: "Example Institute",
  headline: "Annual infrastructure and mobility investment",
  claim: "Public investment plans include regional mobility projects.",
};
const document = {
  sourceUrl: SOURCE,
  mediaType: "text/html",
  text: "A controlled synthetic test response",
  fetchedAt: "2026-10-23T18:30:00.000Z",
  sha256: "a".repeat(64),
};
const job = {
  id: QUEUE_ID,
  name: "research",
  data: { kind: "research", jobId: ID },
} as unknown as Job;

function fixture() {
  const records: Array<{ candidate: SourceCandidate; jobId: string }> = [];
  let discovered = 0;
  let fetched = 0;
  const store: ResearchEvidenceStore = {
    async loadResearchTopic(id) {
      assert.equal(id, ID);
      return TOPIC;
    },
    async saveCandidate(id, value) {
      records.push({ candidate: value, jobId: id });
    },
  };
  const provider: ResearchCandidateProvider = {
    async discover(topic) {
      discovered += 1;
      assert.equal(topic, TOPIC);
      return [candidate];
    },
  };
  const fetcher: ResearchFetchPort = {
    async fetch(url) {
      fetched += 1;
      assert.equal(url, SOURCE);
      return document;
    },
  };
  return { store, provider, fetcher, records, counts: () => ({ discovered, fetched }) };
}

test("synthetic research job records candidate only, not a verified claim", async () => {
  const { store, provider, fetcher, records, counts } = fixture();
  const process = createResearchProcessor(store, provider, fetcher);
  assert.deepEqual(await process(job), {
    candidatesRecorded: 1,
    needsEditorialReview: true,
  });
  assert.deepEqual(counts(), { discovered: 1, fetched: 1 });
  assert.equal(records[0]?.jobId, ID);
  assert.equal(records[0]?.candidate.reviewStatus, "candidate");
  assert.equal(JSON.stringify(records).includes(document.text), false);
});

test("invalid queue identifiers fail before reaching any source port", async () => {
  const { store, provider, fetcher, counts } = fixture();
  const process = createResearchProcessor(store, provider, fetcher);
  for (const broken of [
    { ...job, name: "upload" },
    { ...job, id: "injected" },
    { ...job, data: { ...job.data, role: "admin" } },
    { ...job, data: { kind: "research", jobId: "not-a-uuid" } },
    { ...job, data: null },
  ]) {
    await assert.rejects(process(broken as Job), /Unrecognized research/);
  }
  assert.deepEqual(counts(), { discovered: 0, fetched: 0 });
});

test("discovery refuses zero, many, invalid, and self-certified sources", async () => {
  const { store, fetcher } = fixture();
  for (const discovered of [
    [],
    Array.from({ length: 4 }, () => candidate),
    [{ ...candidate, claim: "short" }],
    [{ ...candidate, reviewStatus: "verified" }],
    [candidate, candidate],
  ]) {
    const provider: ResearchCandidateProvider = { async discover() { return discovered; } };
    const process = createResearchProcessor(store, provider, fetcher);
    await assert.rejects(process(job));
  }
});

test("retrieved content metadata must match the same source URL", async () => {
  const { store, provider } = fixture();
  const process = createResearchProcessor(store, provider, {
    async fetch() { return { ...document, sourceUrl: "https://www.other-site.example/news" }; },
  });
  await assert.rejects(process(job), /retrieval metadata/);
});

test("missing or terminal database jobs fail before discovery", async () => {
  const { provider, fetcher, counts } = fixture();
  const process = createResearchProcessor({
    async loadResearchTopic() { return null; },
    async saveCandidate() { throw new Error("must not write"); },
  }, provider, fetcher);
  await assert.rejects(process(job), /no approved topic/);
  assert.deepEqual(counts(), { discovered: 0, fetched: 0 });
});
