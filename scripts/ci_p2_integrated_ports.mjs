import assert from "node:assert/strict";
import { test } from "node:test";
import { QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { createDormantFeedScheduler } from "../apps/worker/dist/feed-scheduler-composition.js";
import { ISOLATED_FEED_QUEUE } from "../apps/worker/dist/feed-queue-contract.js";
import { createGatedFeedBullmqBridge, ISOLATED_FEED_REDIS_PREFIX } from "../apps/worker/dist/feed-bullmq-bridge.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "../apps/worker/dist/research-service-config.js";
import {
  normalizeFeedArticles,
  groupConservativeEventCandidates,
  rankOfflineEvents,
  buildOfflineDraft,
  exportOfflineEditorialReport,
} from "../apps/worker/dist/offline-editorial-pipeline.js";
import { gateOfflineClaimEvidence } from "../apps/worker/dist/offline-evidence-gate.js";
import { assessEditorialCandidate } from "../apps/worker/dist/bounded-editorial-production.js";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.CI !== "true" ||
  process.env.VNS_P2_ISOLATED_PORT_TEST !== "true"
) {
  throw new Error("P2 integrated port acceptance runs only in isolated GitHub Actions");
}
const host = "news.example.org";
const base = "https://" + host + "/";
const now = new Date();
const publishedAt = new Date(now.getTime() - 600000).toISOString();
const sourceIds = ["rss_feed", "atom_feed", "json_feed"];
const sources = sourceIds.map((id, index) => ({
  id,
  baseUrl: base + ["rss/", "atom/", "json/"][index],
  status: "approved",
  access: ["rss", "atom", "official_api"][index],
  intervalMinutes: 60,
  termsUrl: base + "terms/",
  usage: "metadata_only",
  licenseNotes: "Synthetic metadata only, isolated GitHub Actions test fixture.",
  reviewedAt: "2026-10-26",
}));
const env = {
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
  VNS_FEED_REGISTRY_FILE: REVIEWED_SOURCE_REGISTRY_PATH,
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: host,
  VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
  VNS_FEED_QUEUE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_NAME: ISOLATED_FEED_QUEUE,
};

test(
  "real isolated Redis/BullMQ delivery persists feed metadata to PostgreSQL and never publishes",
  { timeout: 60000 },
  async () => {
    const sql = new Pool({
      host: "127.0.0.1",
      port: 5432,
      database: "vns_p2_ci",
      user: "vns_p2_ci_feed",
      password: process.env.VNS_P2_CI_FEED_PASSWORD,
      max: 2,
      connectionTimeoutMillis: 5000,
    });
    const dba = new Pool({
      host: "127.0.0.1",
      port: 5432,
      database: "vns_p2_ci",
      user: "postgres",
      password: process.env.VNS_P2_CI_PG_PASSWORD,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const connection = { host: "127.0.0.1", port: 6379 };
    const events = new QueueEvents(ISOLATED_FEED_QUEUE, { connection, prefix: ISOLATED_FEED_REDIS_PREFIX });
    const producerConnection = new Redis({ ...connection, maxRetriesPerRequest: null });
    const workerConnection = new Redis({ ...connection, maxRetriesPerRequest: null });
    let bridge;
    let attemptedExternalRequests = 0;
    const fixtures = {
      "/rss/": {
        type: "application/rss+xml",
        body:
          "<rss><channel><item><title>Public science research update</title><link>" +
          base +
          "rss/story</link><pubDate>" +
          publishedAt +
          "</pubDate></item></channel></rss>",
      },
      "/atom/": {
        type: "application/atom+xml",
        body:
          '<feed><entry><title>Public science research update</title><link href="' +
          base +
          'atom/story" /><updated>' +
          publishedAt +
          "</updated></entry></feed>",
      },
      "/json/": {
        type: "application/json",
        body: JSON.stringify({
          items: [
            {
              headline: "Public science research update",
              url: base + "json/story",
              publishedAt,
            },
          ],
        }),
      },
    };
    try {
      const scheduler = createDormantFeedScheduler(env, {
        pool: sql,
        readRegistry: () => JSON.stringify({ version: 1, sources }),
        https: {
          async resolveIPv4() {
            return ["1.1.1.1"];
          },
          async requestPinned(url, ip, headers) {
            assert.equal(ip, "1.1.1.1");
            assert.equal(url.hostname, host);
            attemptedExternalRequests++;
            assert.equal(headers["If-None-Match"], undefined);
            const item = fixtures[url.pathname];
            assert.ok(item);
            return {
              status: 200,
              headers: { "content-type": item.type, etag: '"ci-etag"' },
              body: Buffer.from(item.body),
            };
          },
        },
      });
      bridge = createGatedFeedBullmqBridge(
        {
          ...env,
          VNS_FEED_BULLMQ_BRIDGE_ENABLED: "true",
          VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK: "true",
        },
        scheduler,
        { producer: producerConnection, consumer: workerConnection, now: () => new Date() },
      );
      await events.waitUntilReady();
      await bridge.worker.waitUntilReady();
      const time = new Date();
      const id = await bridge.enqueue(time);
      assert.equal(await bridge.enqueue(time), id);
      const job = await bridge.queue.getJob(id);
      assert.ok(job);
      const result = await job.waitUntilFinished(events, 30000);
      assert.deepEqual(result, {
        ok: true,
        sourcesExamined: 3,
        candidatesAdded: 3,
        notModified: 0,
      });
      assert.equal(attemptedExternalRequests, 3);
      const count = await dba.query(
        "SELECT count(*)::integer AS count FROM vns.feed_poll_candidates",
      );
      assert.equal(count.rows[0].count, 3);
      const acl = await dba.query(
        "SELECT has_function_privilege('vns_p2_ci_feed','vns.project_feed_candidates(text,integer)','EXECUTE') AS allowed",
      );
      assert.equal(acl.rows[0].allowed, false);
      await assert.rejects(
        sql.query("SELECT vns.project_feed_candidates('rss_feed',10)"),
        /permission denied/,
      );
      const rows = await dba.query(
        "SELECT source_id,article_url,headline,published_at FROM vns.feed_poll_candidates ORDER BY source_id",
      );
      const articles = rows.rows.map((row) => ({
        sourceId: row.source_id,
        url: row.article_url,
        headline: row.headline,
        publishedAt: new Date(row.published_at).toISOString(),
        reviewStatus: "candidate",
      }));
      const normalized = normalizeFeedArticles(articles);
      const eventsForReview = groupConservativeEventCandidates(normalized);
      assert.equal(eventsForReview.length, 1);
      const profile = {
        id: "science_news",
        language: "en-US",
        keywords: ["science"],
        blockedTerms: [],
        minIndependentSources: 2,
        maximumArticleAgeHours: 24,
        format: "briefing",
      };
      const ranked = rankOfflineEvents(eventsForReview, profile, new Date());
      assert.equal(ranked.length, 1);
      const draft = buildOfflineDraft(ranked[0], profile);
      assert.equal(gateOfflineClaimEvidence(ranked[0], draft, [], new Date(), 24).ready, false);
      assert.equal(
        exportOfflineEditorialReport(ranked[0], profile, draft).approvedForPublication,
        false,
      );
      const assessment = assessEditorialCandidate(
        ranked[0],
        profile,
        {
          maxAgeHours: 24,
          minimumPublisherGroups: 2,
          relevanceWeight: 10,
          freshnessWeight: 10,
          qualityWeight: 10,
          explanatoryWeight: 10,
          blockedTerms: [],
        },
        sourceIds.map((sourceId) => ({
          sourceId,
          publisherGroup: "shared_syndication",
          rightsApproved: true,
          quality: 3,
        })),
        new Date(),
      );
      assert.equal(assessment.eligible, false);
      assert.ok(assessment.reasons.includes("publisher_groups_insufficient"));
      for (const source of sourceIds) {
        const projected = await dba.query(
          "SELECT vns.project_feed_candidates($1::text,10) AS count",
          [source],
        );
        assert.equal(projected.rows[0].count, 1);
      }
      const projection = await dba.query(
        "SELECT count(*)::integer AS count FROM vns.research_event_articles",
      );
      assert.equal(projection.rows[0].count, 3);
      const second = await dba.query("SELECT vns.project_feed_candidates('rss_feed',10) AS count");
      assert.equal(second.rows[0].count, 0);
      const stillCandidate = await dba.query(
        "SELECT count(*)::integer AS count FROM vns.feed_poll_candidates WHERE review_status = 'candidate'",
      );
      assert.equal(stillCandidate.rows[0].count, 3);
    } finally {
      await bridge?.close().catch(() => undefined);
      await events.close().catch(() => undefined);
      await producerConnection.quit().catch(() => undefined);
      await workerConnection.quit().catch(() => undefined);
      await sql.end().catch(() => undefined);
      await dba.end().catch(() => undefined);
    }
  },
);
