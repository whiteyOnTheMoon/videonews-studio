import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { createDormantFeedScheduler } from "./feed-scheduler-composition.js";
import {
  createDormantFeedQueueContract,
  ISOLATED_FEED_QUEUE,
  FEED_TICK_JOB_NAME,
  type FeedTickDelivery,
} from "./feed-queue-contract.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "./research-service-config.js";

const BASE = "https://news.example.org/";
const START = new Date("2026-10-26T12:00:00.000Z");
const TOKEN = "11111111-2222-4333-8444-555555555555";
const sources = ["rss_feed", "atom_feed", "json_feed"].map((id, index) => ({
  id,
  baseUrl: BASE + ["rss/", "atom/", "json/"][index],
  status: "approved",
  access: ["rss", "atom", "official_api"][index],
  intervalMinutes: 60,
  termsUrl: BASE + "terms/",
  usage: "metadata_only",
  licenseNotes: "Synthetic fixture for offline testing only.",
  reviewedAt: "2026-10-26",
}));
const env = {
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
  VNS_FEED_REGISTRY_FILE: REVIEWED_SOURCE_REGISTRY_PATH,
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: "news.example.org",
  VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
  VNS_FEED_QUEUE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_NAME: ISOLATED_FEED_QUEUE,
};

test("synthetic configured sources pass through queued tick, pinned transport and SQL dedupe", async () => {
  const saved = new Set<string>();
  const leases = new Map<string, { until: number; etag: string | null }>();
  const jobs = new Map<string, FeedTickDelivery>();
  const requests: string[] = [];
  let now = START.getTime();
  const pool = {
    async query(sql: string, args: unknown[]) {
      const id = String(args[0]);
      if (sql.includes("vns.claim_feed_poll")) {
        const lease = leases.get(id);
        if (lease && now < lease.until) return { rows: [] };
        leases.set(id, { until: now + 60 * 60000, etag: lease?.etag ?? null });
        return { rows: [{ token: TOKEN, etag: lease?.etag ?? null, last_modified: null }] };
      }
      if (sql.includes("vns.commit_feed_poll")) {
        assert.equal(args[1], TOKEN);
        const items = JSON.parse(String(args[2])) as Array<{ url: string }>;
        let created = 0;
        for (const item of items) {
          const key = id + "|" + item.url;
          if (!saved.has(key)) {
            saved.add(key);
            created++;
          }
        }
        leases.get(id)!.etag = args[3] as string | null;
        return { rows: [{ created }] };
      }
      throw new Error("Unexpected SQL");
    },
  } as unknown as Pool;
  const payload: Record<string, { type: string; body: string }> = {
    "/rss/": {
      type: "application/rss+xml",
      body:
        "<rss><channel><item><title>Public science research update</title><link>" +
        BASE +
        "rss/story</link></item></channel></rss>",
    },
    "/atom/": {
      type: "application/atom+xml",
      body:
        '<feed><entry><title>Public science research update</title><link href="' +
        BASE +
        'atom/story" /></entry></feed>',
    },
    "/json/": {
      type: "application/json",
      body: JSON.stringify({
        items: [{ headline: "Public science research update", url: BASE + "json/story" }],
      }),
    },
  };
  const scheduler = createDormantFeedScheduler(env, {
    pool,
    readRegistry: () => JSON.stringify({ version: 1, sources }),
    https: {
      async resolveIPv4() {
        return ["1.1.1.1"];
      },
      async requestPinned(url, ip, headers) {
        assert.equal(ip, "1.1.1.1");
        requests.push(url.pathname);
        if (headers["If-None-Match"]) return { status: 304, headers: {}, body: Buffer.alloc(0) };
        const fixture = payload[url.pathname]!;
        return {
          status: 200,
          headers: { "content-type": fixture.type, etag: '"synthetic"' },
          body: Buffer.from(fixture.body),
        };
      },
    },
  });
  const queue = {
    name: ISOLATED_FEED_QUEUE,
    async add(
      name: typeof FEED_TICK_JOB_NAME,
      data: { kind: typeof FEED_TICK_JOB_NAME; slot: number },
      options: { jobId: string },
    ) {
      jobs.set(options.jobId, { id: options.jobId, name, queueName: ISOLATED_FEED_QUEUE, data });
    },
  };
  const contract = createDormantFeedQueueContract(env, scheduler, queue);
  const firstId = await contract.enqueue(START);
  assert.deepEqual(await contract.process(jobs.get(firstId)!, START), {
    ok: true,
    sourcesExamined: 3,
    candidatesAdded: 3,
    notModified: 0,
  });
  assert.equal(saved.size, 3);
  assert.deepEqual(requests, ["/rss/", "/atom/", "/json/"]);
  assert.equal((await contract.process(jobs.get(firstId)!, START)).candidatesAdded, 0);
  now += 60 * 60000;
  const secondTime = new Date(now);
  const secondId = await contract.enqueue(secondTime);
  assert.deepEqual(await contract.process(jobs.get(secondId)!, secondTime), {
    ok: true,
    sourcesExamined: 3,
    candidatesAdded: 0,
    notModified: 3,
  });
  assert.equal(saved.size, 3);
});

test("no opt-in means no registry read, SQL or queued work", () => {
  let touched = false;
  assert.throws(
    () =>
      createDormantFeedScheduler(
        { ...env, VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "false" },
        {
          pool: {
            query: async () => {
              touched = true;
              return { rows: [] };
            },
          } as unknown as Pool,
          readRegistry: () => {
            touched = true;
            return "{}";
          },
          https: {
            resolveIPv4: async () => {
              touched = true;
              return ["1.1.1.1"];
            },
            requestPinned: async () => {
              touched = true;
              throw Error("should not run");
            },
          },
        },
      ),
    /disabled/,
  );
  assert.equal(touched, false);
});
