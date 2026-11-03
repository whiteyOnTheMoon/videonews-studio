import assert from "node:assert/strict";
import test from "node:test";
import {
  createDormantFeedPoller,
  type FeedPollStore,
  type FeedTransport,
} from "./feed-poller.js";
import type { RegisteredResearchSource } from "./source-registry.js";

const sources: RegisteredResearchSource[] = ["alpha", "beta", "gamma"].map((name) => ({
  id: "agency_" + name,
  baseUrl: "https://www.example.org/" + name + "/",
  status: "approved",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://www.example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "Reviewed metadata terms permit limited headlines.",
  reviewedAt: "2026-10-31",
}));

const store: FeedPollStore = {
  async claim() {
    return {
      token: "11111111-2222-4333-8444-555555555555",
      validators: { etag: null, lastModified: null },
    };
  },
  async commit() {
    throw new Error("PRIVATE_DB_PASSWORD");
  },
};

test("real transport failures produce only approved IDs and fixed stage labels", async () => {
  const events: Array<{ id: string; stage: string }> = [];
  const transport: FeedTransport = {
    async request(source) {
      throw new Error("SECRET_TLS_DNS:" + source.baseUrl);
    },
  };
  const poller = createDormantFeedPoller(
    sources,
    true,
    store,
    transport,
    undefined,
    (id, stage) => events.push({ id, stage }),
  );
  const result = await poller.poll(new Date("2026-11-03T17:00:00Z"));
  assert.deepEqual(events, sources.map((source) => ({
    id: source.id,
    stage: "https_transport",
  })));
  assert.ok(result.every((value) => value.status === "failed" && value.newItems === 0));
  assert.ok(!JSON.stringify(result).includes("stage"));
  assert.ok(!JSON.stringify(events).includes("SECRET_TLS_DNS"));
  assert.ok(!JSON.stringify(events).includes("https://"));
});

test("invalid RSS is labeled feed_decode; failed diagnostic callback cannot affect outcome", async () => {
  const events: string[] = [];
  const invalid: FeedTransport = {
    async request() {
      return {
        status: 200,
        mediaType: "application/rss+xml",
        body: "synthetic bad RSS",
        etag: null,
        lastModified: null,
      };
    },
  };
  const reporter = (id: string, stage: string) => {
    events.push(id + ":" + stage);
    if (id === "agency_beta") throw new Error("PRIVATE_LOGGER_EXCEPTION");
  };
  const poller = createDormantFeedPoller(sources, true, store, invalid, undefined, reporter);
  const result = await poller.poll(new Date("2026-11-03T17:00:00Z"));
  assert.equal(result.length, 3);
  assert.ok(result.every((value) => value.status === "failed"));
  assert.deepEqual(
    events,
    sources.map((source) => source.id + ":feed_decode"),
  );
});
