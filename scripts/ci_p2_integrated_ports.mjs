import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { createDormantFeedScheduler } from "../apps/worker/dist/feed-scheduler-composition.js";
import { ISOLATED_FEED_QUEUE } from "../apps/worker/dist/feed-queue-contract.js";
import {
  createGatedFeedBullmqBridge,
  ISOLATED_FEED_REDIS_PREFIX,
} from "../apps/worker/dist/feed-bullmq-bridge.js";
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
import { attestFeedDatabaseIdentity } from "../apps/worker/dist/feed-runtime-admission.js";
import {
  projectApprovedSource,
  readProjectionAdmission,
} from "../apps/worker/dist/feed-candidate-project-once.js";
import { runContinuousProjection } from "../apps/worker/dist/feed-project-continuous.js";
import { attestSourcePublisherIdentity } from "../apps/worker/dist/feed-source-publish-once.js";
import { publishApprovedAdminSourceFile } from "../apps/worker/dist/postgres-admin-source-publisher.js";
import { acceptDormantSourceFile } from "../apps/worker/dist/source-export-files.js";

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
  VNS_FEED_RUNTIME_ENABLED: "true",
  VNS_FEED_OFFLINE_COMPOSITION_ENABLED: "true",
  VNS_FEED_OFFLINE_OPERATOR_ACK: "true",
  VNS_FEED_REGISTRY_FILE: REVIEWED_SOURCE_REGISTRY_PATH,
  VNS_SOURCE_FETCH_ENABLED: "true",
  VNS_ALLOWED_SOURCE_HOSTS: host,
  VNS_FEED_QUEUE_CONTRACT_ENABLED: "true",
  VNS_FEED_QUEUE_OPERATOR_ACK: "true",
  VNS_FEED_QUEUE_NAME: ISOLATED_FEED_QUEUE,
};

/** Synthetic governance setup: the identities are disposable CI fixtures only. */
async function seedReviewedSyntheticSources(dba) {
  const sourceActor = "ca340001-1111-4111-8111-111111111111";
  const hostActor = "ca340002-2222-4222-8222-222222222222";
  // Disposable CI superuser bootstrap only. Real operator enrollment must
  // use a separately authenticated provisioner and documented governance.
  await dba.query(
    `INSERT INTO vns.editor_operator_registry
      (login_role,operator_id,operator_label,active)
     VALUES (session_user,$1::uuid,'CI synthetic provisioner',true)`,
    ["ca340003-3333-4333-8333-333333333333"],
  );
  await dba.query(
    `INSERT INTO vns.editor_accounts(id,username,display_name,role,password_hash,active)
     VALUES ($1,'ci_port_source','Synthetic Source Reviewer','admin',
       'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true),
       ($2,'ci_port_host','Synthetic Host Reviewer','admin',
       'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true)`,
    [sourceActor, hostActor],
  );
  const recordedAt = "2026-10-26T12:00:00Z";
  let revision = 0;
  const snapshot = [];
  for (const source of sources) {
    snapshot.push({ ...source, status: "pending" });
    let result = await dba.query(
      `SELECT vns.admin_commit_source_registry(
        $1::bigint,$2::bigint,$3::jsonb,$4::text,$5::text,
        $6::uuid,$7::integer,$8::timestamptz) AS saved`,
      [
        revision,
        revision + 1,
        JSON.stringify(snapshot),
        source.id,
        "create_pending",
        sourceActor,
        0,
        recordedAt,
      ],
    );
    assert.equal(result.rows[0]?.saved, true);
    revision++;
    snapshot[snapshot.length - 1] = source;
    result = await dba.query(
      `SELECT vns.admin_commit_source_registry(
        $1::bigint,$2::bigint,$3::jsonb,$4::text,$5::text,
        $6::uuid,$7::integer,$8::timestamptz) AS saved`,
      [
        revision,
        revision + 1,
        JSON.stringify(snapshot),
        source.id,
        "approve",
        sourceActor,
        0,
        recordedAt,
      ],
    );
    assert.equal(result.rows[0]?.saved, true);
    revision++;
  }
  const grant = await dba.query(
    `SELECT vns.admin_change_source_host_approval(
       0::bigint,$1::bigint,'grant',$2::text,$3::text,
       $4::uuid,0::integer) AS saved`,
    [revision, host, "Distinct synthetic reviewer authorizes metadata feed hostname.", hostActor],
  );
  assert.equal(grant.rows[0]?.saved, true);
}

test(
  "real isolated Redis/BullMQ delivery persists feed metadata to PostgreSQL and never publishes",
  { timeout: 60000 },
  async () => {
    const sql = new Pool({
      host: "127.0.0.1",
      port: 5432,
      database: "vns_p2_ci",
      user: "vns_feed_login_ciunit",
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
    const exportSql = new Pool({
      host: "127.0.0.1",
      port: 5432,
      database: "vns_p2_ci",
      user: "vns_source_export_login_ciunit",
      password: process.env.VNS_P2_CI_EXPORT_PASSWORD,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const projectorSql = new Pool({
      host: "127.0.0.1",
      port: 5432,
      database: "vns_p2_ci",
      user: "vns_feed_project_login_ciunit",
      password: process.env.VNS_P2_CI_PROJECT_PASSWORD,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const sourceStateRoot = await mkdtemp(join(tmpdir(), "vns-ci-signed-config-"));
    const publisherDir = join(sourceStateRoot, "publisher");
    const consumerDir = join(sourceStateRoot, "consumer");
    await mkdir(publisherDir, { mode: 0o700 });
    await mkdir(consumerDir, { mode: 0o700 });
    const connection = { host: "127.0.0.1", port: 6379 };
    const events = new QueueEvents(ISOLATED_FEED_QUEUE, {
      connection,
      prefix: ISOLATED_FEED_REDIS_PREFIX,
    });
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
      await seedReviewedSyntheticSources(dba);
      // Real disposable login, not a SET ROLE simulation of the publisher.
      await attestSourcePublisherIdentity(exportSql, "vns_source_export_login_ciunit");
      await assert.rejects(
        attestSourcePublisherIdentity(dba, "vns_source_export_login_ciunit"),
        /database admission denied/,
      );
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const sourcePolicy = { enabled: true, hosts: [host] };
      const revisions = await publishApprovedAdminSourceFile(
        exportSql,
        publisherDir,
        sourcePolicy,
        privateKey,
      );
      assert.equal(revisions.sourceRevision, sources.length * 2);
      assert.equal(revisions.hostApprovalRevision, 1);
      const acceptedSources = await acceptDormantSourceFile(
        publisherDir,
        consumerDir,
        sourcePolicy,
        publicKey,
        true,
        {
          async advance(candidate) {
            // Only a simulated anchor in the disposable CI cluster.
            // Independent production anchor admission is a separate gate.
            assert.equal(candidate.sourceRevision, revisions.sourceRevision);
            assert.equal(candidate.hostApprovalRevision, revisions.hostApprovalRevision);
          },
        },
      );
      assert.deepEqual(
        acceptedSources,
        [...sources].sort((a, b) => a.id.localeCompare(b.id)),
      );
      await attestFeedDatabaseIdentity(sql, "vns_feed_login_ciunit");
      await assert.rejects(
        attestFeedDatabaseIdentity(dba, "vns_feed_login_ciunit"),
        /admission denied/,
      );
      const scheduler = createDormantFeedScheduler(env, {
        pool: sql,
        readRegistry: () => JSON.stringify({ version: 1, sources: acceptedSources }),
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
        "SELECT has_function_privilege('vns_feed_login_ciunit','vns.project_feed_candidates(text,integer)','EXECUTE') AS allowed",
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
      // Actual isolated PostgreSQL writer -> new atomic ranking -> named
      // SQL reader, under distinct socket-authenticated least-privilege logins.
      // Only the fixture DBA loads a synthetic profile / personal login.
      await dba.query(
        `UPDATE vns.editorial_profile_registry
          SET revision=1,profiles=$1::jsonb WHERE singleton=true`,
        [JSON.stringify([profile])],
      );
      await dba.query(
        `CREATE ROLE editor_ci_fullchain LOGIN INHERIT PASSWORD 'ci_only_fullchain_disposable_reader'`,
      );
      await dba.query(`GRANT vns_p2_named_client TO editor_ci_fullchain`);
      await dba.query(
        `INSERT INTO vns.editor_db_principals(login_role,editor_id,auth_version,active)
         VALUES('editor_ci_fullchain',$1::uuid,0,true)`,
        ["ca340001-1111-4111-8111-111111111111"],
      );
      const projectorBase = {
        VNS_P2_FEED_PROJECTION_ENABLED: "true",
        VNS_P2_FEED_PROJECTION_OPERATOR_ACK: "true",
        VNS_P2_FEED_PROJECTION_CONTINUOUS_ENABLED: "true",
        VNS_P2_FEED_PROJECTION_CONTINUOUS_OPERATOR_ACK: "true",
        VNS_P2_FEED_PROJECTION_MODE: "continuous",
        VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP: "false",
        VNS_P2_FEED_PROJECTION_DB_HOST: "127.0.0.1",
        VNS_P2_FEED_PROJECTION_DB_USER: "vns_feed_project_login_ciunit",
        VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE: "/run/secrets/vns_feed_project_db_password",
        VNS_P2_FEED_PROJECTION_SOURCE_IDS: sourceIds.join(","),
        VNS_P2_FEED_PROJECTION_LIMIT: "10",
        VNS_P2_FEED_PROJECTION_INTERVAL_MINUTES: "15",
      };
      const stopper = new AbortController();
      let cycles = 0;
      await runContinuousProjection(
        projectorBase,
        stopper.signal,
        async (single) => {
          const projected = await projectApprovedSource(
            projectorSql,
            readProjectionAdmission(single),
          );
          assert.equal(projected, 1);
          cycles++;
        },
        async (duration) => {
          assert.equal(duration, 900000);
          stopper.abort();
        },
      );
      assert.equal(cycles, 3);
      const projection = await dba.query(
        "SELECT count(*)::integer AS count FROM vns.research_event_articles",
      );
      assert.equal(projection.rows[0].count, 3);
      const ranks = await dba.query(
        `SELECT profile_id,profile_revision,score,article_count,source_count,
                reasons,approved_for_publication
         FROM vns.feed_event_rankings`,
      );
      assert.equal(ranks.rows.length, 1);
      assert.equal(ranks.rows[0].profile_id, "science_news");
      assert.equal(Number(ranks.rows[0].profile_revision), 1);
      assert.equal(ranks.rows[0].article_count, 3);
      assert.equal(ranks.rows[0].source_count, 3);
      assert.equal(ranks.rows[0].approved_for_publication, false);
      assert.ok(ranks.rows[0].reasons.includes("independent_verification_required"));
      const reader = new Pool({
        host: "127.0.0.1",
        port: 5432,
        database: "vns_p2_ci",
        user: "editor_ci_fullchain",
        password: "ci_only_fullchain_disposable_reader",
        max: 1,
      });
      try {
        const viewed = await reader.query(
          "SELECT * FROM vns.named_ranked_feed_page($1::integer)",
          [25],
        );
        assert.equal(viewed.rows.length, 1);
        assert.equal(viewed.rows[0].source_count, 3);
        assert.equal(viewed.rows[0].approved_for_publication, false);
      } finally {
        await reader.end();
      }
      // Retried projectors should keep one durable event/profile revision.
      for (const source of sourceIds) {
        const projected = await projectApprovedSource(
          projectorSql,
          readProjectionAdmission({
            ...projectorBase,
            VNS_P2_FEED_PROJECTION_MODE: "single_pass",
            VNS_P2_FEED_PROJECTION_SOURCE_ID: source,
          }),
        );
        assert.equal(projected, 0);
      }
      const durable = await dba.query(
        "SELECT count(*)::integer AS count FROM vns.feed_event_rankings",
      );
      assert.equal(durable.rows[0].count, 1);
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
      await exportSql.end().catch(() => undefined);
      await projectorSql.end().catch(() => undefined);
      await dba.end().catch(() => undefined);
      await rm(sourceStateRoot, { recursive: true, force: true });
    }
  },
);
