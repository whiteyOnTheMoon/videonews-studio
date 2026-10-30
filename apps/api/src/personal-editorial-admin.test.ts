import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  DormantPersonalEditorialAdmin,
  validateNamedEditorialProfiles,
  validateNamedCheckpointWrite,
  validateNamedTimelineWrite,
  validateNamedRankingPolicySettings,
  validateNamedPublisherReviewWrite,
  validateNamedEventFactorReviewWrite,
  type NamedEditorialPgSession,
} from "./personal-editorial-admin.js";

const ACTOR = "ca310001-1111-4111-8111-111111111111";
const ORIGIN = "https://studio.example.invalid";
const profile = {
  id: "science_news",
  language: "de-DE",
  keywords: ["science"],
  blockedTerms: [],
  minIndependentSources: 2,
  maximumArticleAgeHours: 24,
  format: "briefing",
};
function request(url: string, method = "GET", body?: unknown, origin = ORIGIN) {
  return Object.assign(Readable.from([body === undefined ? "" : JSON.stringify(body)]), {
    url,
    method,
    headers: {
      origin,
      "content-type": "application/json",
      cookie: "__Host-vns_editor=ci-personal-session",
    },
  }) as unknown as IncomingMessage;
}
function response() {
  const fake = {
    code: 0,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(code: number) {
      this.code = code;
    },
    end(data: string) {
      this.body = data;
    },
  };
  return fake as unknown as ServerResponse & typeof fake;
}
function setup(mismatch = false, enabled = true) {
  let opened = 0;
  let closed = 0;
  const sql: string[] = [];
  const client = {
    async query(sqlText: string) {
      sql.push(sqlText);
      if (sqlText.includes("named_current_editor")) {
        return {
          rows: [
            {
              editor_id: mismatch ? "ca310099-9999-4999-8999-999999999999" : ACTOR,
              auth_version: 0,
              editor_role: "admin",
            },
          ],
        };
      }
      if (sqlText.includes("named_timeline_append")) {
        return { rows: [{ event_id: "ca310004-4444-4444-8444-444444444444" }] };
      }
      if (sqlText.includes("named_ranked_feed_page")) {
        return {
          rows: [
            {
              event_id: "ca310002-2222-4222-8222-222222222222",
              profile_id: "science_news",
              profile_revision: "1",
              headline: "Synthetic science update awaiting independent review",
              score: 42,
              article_count: 2,
              source_count: 1,
              reasons: ["metadata_candidate_only", "independent_verification_required"],
              ranked_at: new Date("2026-10-28T12:00:00.000Z"),
              approved_for_publication: false,
            },
          ],
        };
      }
      if (sqlText.includes("named_publisher_review_read")) {
        return {
          rows: [
            {
              source_revision: "5",
              reviewed: false,
              publisher_group: null,
              quality: null,
            },
          ],
        };
      }
      if (sqlText.includes("named_event_factor_review_read")) {
        return {
          rows: [
            {
              profile_revision: "1",
              policy_revision: "2",
              reviewed: false,
              explanatory_value: null,
              visualizability: null,
              risk: null,
            },
          ],
        };
      }
      if (
        sqlText.includes("named_publisher_review_commit") ||
        sqlText.includes("named_event_factor_review_commit")
      ) {
        return { rows: [{ saved: true }] };
      }
      if (sqlText.includes("named_ranking_policy_read")) {
        return {
          rows: [
            {
              profile_revision: "1",
              policy_revision: "0",
              settings: null,
            },
          ],
        };
      }
      if (sqlText.includes("named_ranking_policy_commit")) {
        return { rows: [{ saved: true }] };
      }
      if (sqlText.includes("named_profile_read")) {
        return { rows: [{ revision: "0", profiles: [] }] };
      }
      if (
        sqlText.includes("named_profile_commit") ||
        sqlText.includes("named_append_editorial_checkpoint")
      ) {
        return { rows: [{ saved: true }] };
      }
      return { rows: [] };
    },
    async close() {
      closed++;
    },
  } as unknown as NamedEditorialPgSession;
  const handler = new DormantPersonalEditorialAdmin(
    {
      async authenticatedAdminIdentity() {
        return { id: ACTOR, authVersion: 0, username: "ci_admin", role: "admin" as const };
      },
    },
    {
      originAllowed(req) {
        return req.headers.origin === ORIGIN;
      },
    },
    {
      async open() {
        opened++;
        return client;
      },
    },
    enabled,
  );
  return {
    handler,
    sql,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
  };
}
async function serve(
  instance: DormantPersonalEditorialAdmin,
  url: string,
  method = "GET",
  body?: unknown,
  origin = ORIGIN,
) {
  const result = response();
  assert.equal(await instance.handle(request(url, method, body, origin), result), true);
  return {
    status: result.code,
    json: JSON.parse(result.body) as Record<string, unknown>,
    headers: result.headers,
  };
}

test("strict profile settings reject injected keys, bogus budgets and duplicate IDs", () => {
  assert.deepEqual(validateNamedEditorialProfiles([profile]), [profile]);
  for (const bad of [
    [{ ...profile, apiKey: "forbidden" }],
    [{ ...profile, maximumArticleAgeHours: 0 }],
    [{ ...profile, keywords: ["s"] }],
    [{ ...profile, language: "javascript:evil" }],
    [{ ...profile, keywords: ["science", "Science"] }],
    [{ ...profile, keywords: ["science-news", "science news"] }],
    [{ ...profile, keywords: ["--"] }],
    [{ ...profile, blockedTerms: ["SCIENCE"] }],
    [{ ...profile, keywords: Array.from({ length: 31 }, (_, i) => "topic" + i) }],
    [profile, profile],
  ]) {
    assert.equal(validateNamedEditorialProfiles(bad), null);
  }
});

test("disabled handler cannot open a personal DB connection", async () => {
  const state = setup(false, false);
  assert.equal((await serve(state.handler, "/admin/editorial-profiles")).status, 404);
  assert.equal(state.opened, 0);
});

test("Admin read/write requires personal DB attestation and audit revision", async () => {
  const state = setup();
  const read = await serve(state.handler, "/admin/editorial-profiles");
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { revision: 0, profiles: [] });
  assert.equal(read.headers["cache-control"], "no-store");
  const saved = await serve(state.handler, "/admin/editorial-profiles", "POST", {
    expectedRevision: 0,
    profiles: [profile],
  });
  assert.deepEqual(saved.json, {
    saved: true,
    revision: 1,
    productionActive: false,
  });
  assert.equal(state.opened, 2);
  assert.equal(state.closed, 2);
  assert.ok(state.sql.every((sql) => !sql.includes("ci_admin")));
});

test("mismatched DB principal, invalid payload and forged origin are blocked", async () => {
  const mismatch = setup(true);
  assert.equal((await serve(mismatch.handler, "/admin/editorial-profiles")).status, 403);
  assert.equal(mismatch.closed, 1);
  assert.equal(mismatch.sql.length, 1);
  const state = setup();
  assert.equal(
    (
      await serve(state.handler, "/admin/editorial-profiles", "POST", {
        expectedRevision: 0,
        profiles: [{ ...profile, apiKey: "x" }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await serve(
        state.handler,
        "/admin/editorial-profiles",
        "POST",
        { expectedRevision: 0, profiles: [profile] },
        "https://invalid.example",
      )
    ).status,
    403,
  );
  assert.equal(state.opened, 0);
});

test("bounded timeline and checkpoint cursor exports require exact IDs", async () => {
  const state = setup();
  const story = "ca310002-2222-4222-8222-222222222222";
  assert.equal(
    (await serve(state.handler, "/admin/editorial-timeline?storyId=" + story + "&limit=10")).status,
    200,
  );
  assert.equal(
    (
      await serve(
        state.handler,
        "/admin/editorial-checkpoints?eventId=" + story + "&after=0&limit=10",
      )
    ).status,
    200,
  );
  assert.equal(
    (await serve(state.handler, "/admin/editorial-checkpoints?eventId=bad&after=0&limit=10"))
      .status,
    400,
  );
  assert.equal(state.opened, 3);
  assert.equal(state.closed, 3);
});

test("authenticated admin writes bounded append-only checkpoint, never publication approval", async () => {
  const state = setup();
  const payload = {
    eventId: "ca310002-2222-4222-8222-222222222222",
    expectedRevision: 0,
    stage: "ranking",
    outcome: "candidate",
    artifactSha256: "a".repeat(64),
    reasonCodes: ["metadata_candidate_only"],
    score: 42,
  };
  assert.deepEqual(validateNamedCheckpointWrite(payload), payload);
  const result = await serve(state.handler, "/admin/editorial-checkpoints", "POST", payload);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, {
    saved: true,
    revision: 1,
    approvedForPublication: false,
  });
  assert.equal(state.opened, 1);
  assert.equal(state.closed, 1);
  assert.ok(state.sql.some((sql) => sql.includes("named_append_editorial_checkpoint")));
  assert.ok(state.sql.every((sql) => !sql.includes("metadata_candidate_only")));
});

test("checkpoint command rejects forged identity, non-revisioned data and origin bypass", async () => {
  const payload = {
    eventId: "ca310002-2222-4222-8222-222222222222",
    expectedRevision: 0,
    stage: "quality",
    outcome: "needs_review",
    artifactSha256: "b".repeat(64),
    reasonCodes: ["independent_review_required"],
    score: null,
  };
  const state = setup();
  for (const delta of [
    { actorId: ACTOR },
    { stage: "publish" },
    { approvedForPublication: true },
    { expectedRevision: -1 },
    { artifactSha256: "not_a_digest" },
    { reasonCodes: [] },
    { reasonCodes: ["bad Secret"] },
    { score: 1001 },
  ]) {
    assert.equal(validateNamedCheckpointWrite({ ...payload, ...delta }), null);
    assert.equal(
      (
        await serve(state.handler, "/admin/editorial-checkpoints", "POST", {
          ...payload,
          ...delta,
        })
      ).status,
      400,
    );
  }
  assert.equal(state.opened, 0);
  assert.equal(
    (
      await serve(
        state.handler,
        "/admin/editorial-checkpoints",
        "POST",
        payload,
        "https://attacker.example",
      )
    ).status,
    403,
  );
  assert.equal(state.opened, 0);
  assert.equal(
    (await serve(setup(true).handler, "/admin/editorial-checkpoints", "POST", payload)).status,
    403,
  );
});

test("personally authenticated story audit appends exact bounded metadata only", async () => {
  const state = setup();
  const payload = {
    storyId: "ca310002-2222-4222-8222-222222222222",
    eventKind: "claim_rejected",
    referenceUri: "https://example.org/source/review",
    documentSha256: "a".repeat(64),
    details: {
      summary: "Rejected unsupported numerical estimate from current source.",
      reasonCodes: ["claim_evidence_unverified"],
    },
  };
  assert.deepEqual(validateNamedTimelineWrite(payload), payload);
  const result = await serve(state.handler, "/admin/editorial-timeline", "POST", payload);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, {
    eventId: "ca310004-4444-4444-8444-444444444444",
    approvedForPublication: false,
  });
  assert.ok(state.sql.some((sql) => sql.includes("named_timeline_append")));
  assert.ok(state.sql.every((sql) => !sql.includes(payload.details.summary)));
  assert.equal(state.closed, 1);
});

test("redacted story audit refuses unsafe references, unapproved fields and stale identities", async () => {
  const base = {
    storyId: "ca310002-2222-4222-8222-222222222222",
    eventKind: "source",
    referenceUri: "https://example.org/a",
    documentSha256: null,
    details: {
      summary: "Evidence source awaits independent review.",
      reasonCodes: ["source_attested"],
    },
  };
  const state = setup();
  for (const change of [
    { actorId: ACTOR },
    { approvedForPublication: true },
    { eventKind: "publish" },
    { referenceUri: "file:///etc/passwd" },
    { referenceUri: "https://user:pass@example.org/a" },
    { documentSha256: "bogus" },
    { details: { summary: "short", reasonCodes: ["ok"] } },
    { details: { summary: "This is long enough.", reasonCodes: ["invalid Reason"] } },
    { details: { ...base.details, credential: "forbidden" } },
  ]) {
    assert.equal(validateNamedTimelineWrite({ ...base, ...change }), null);
    const reply = await serve(state.handler, "/admin/editorial-timeline", "POST", {
      ...base,
      ...change,
    });
    assert.equal(reply.status, 400);
  }
  assert.equal(state.opened, 0);
  assert.equal(
    (
      await serve(
        state.handler,
        "/admin/editorial-timeline",
        "POST",
        base,
        "https://forged.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (await serve(setup(true).handler, "/admin/editorial-timeline", "POST", base)).status,
    403,
  );
});

test("named read-only ranking shows durable candidate metadata only after personal DB identity", async () => {
  const state = setup();
  const result = await serve(state.handler, "/admin/editorial-ranked-events?limit=25");
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, {
    metadataOnly: true,
    candidates: [
      {
        eventId: "ca310002-2222-4222-8222-222222222222",
        profileId: "science_news",
        profileRevision: 1,
        headline: "Synthetic science update awaiting independent review",
        score: 42,
        articleCount: 2,
        sourceCount: 1,
        reasons: ["metadata_candidate_only", "independent_verification_required"],
        rankedAt: "2026-10-28T12:00:00.000Z",
        approvedForPublication: false,
      },
    ],
  });
  assert.ok(state.sql.some((sql) => sql.includes("named_ranked_feed_page")));
  assert.equal(state.opened, 1);
  assert.equal(state.closed, 1);
  for (const bad of [
    "/admin/editorial-ranked-events",
    "/admin/editorial-ranked-events?limit=0",
    "/admin/editorial-ranked-events?limit=51",
    "/admin/editorial-ranked-events?limit=1&limit=2",
    "/admin/editorial-ranked-events?limit=25&actor=forged",
  ]) {
    assert.equal((await serve(state.handler, bad)).status, 400);
  }
  assert.equal(
    (await serve(state.handler, "/admin/editorial-ranked-events?limit=25", "POST", {})).status,
    405,
  );
  assert.equal(
    (await serve(setup(true).handler, "/admin/editorial-ranked-events?limit=25")).status,
    403,
  );
});

test("ranking policy review is bounded, attributed and never a publication decision", async () => {
  const settings = {
    minimumPublisherGroups: 2,
    relevanceWeight: 10,
    freshnessWeight: 20,
    qualityWeight: 15,
    explanatoryWeight: 5,
    visualizabilityWeight: 30,
    riskWeight: 20,
    maximumRisk: 3,
  };
  assert.deepEqual(validateNamedRankingPolicySettings(settings), settings);
  const state = setup();
  const read = await serve(state.handler, "/admin/editorial-ranking-policy?profileId=science_news");
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, {
    profileId: "science_news",
    profileRevision: 1,
    policyRevision: 0,
    settings: null,
    productionActive: false,
  });
  const saved = await serve(state.handler, "/admin/editorial-ranking-policy", "POST", {
    profileId: "science_news",
    expectedRevision: 0,
    settings,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, {
    saved: true,
    policyRevision: 1,
    productionActive: false,
  });
  assert.ok(state.sql.some((sql) => sql.includes("named_ranking_policy_read")));
  assert.ok(state.sql.some((sql) => sql.includes("named_ranking_policy_commit")));
  assert.ok(state.sql.every((sql) => !sql.includes("ci_admin")));
  assert.equal(state.opened, 2);
  assert.equal(state.closed, 2);
});

test("ranking policy rejects forged editor, unbounded risks, unexpected fields and invalid queries", async () => {
  const settings = {
    minimumPublisherGroups: 2,
    relevanceWeight: 10,
    freshnessWeight: 20,
    qualityWeight: 15,
    explanatoryWeight: 5,
    visualizabilityWeight: 30,
    riskWeight: 20,
    maximumRisk: 3,
  };
  const state = setup();
  for (const bogus of [
    { ...settings, riskWeight: 101 },
    { ...settings, maximumRisk: 6 },
    { ...settings, minimumPublisherGroups: 1 },
    { ...settings, publisherQualityToken: "forged" },
    { ...settings, explanatoryWeight: "10" },
  ]) {
    assert.equal(validateNamedRankingPolicySettings(bogus), null);
    assert.equal(
      (
        await serve(state.handler, "/admin/editorial-ranking-policy", "POST", {
          profileId: "science_news",
          expectedRevision: 0,
          settings: bogus,
        })
      ).status,
      400,
    );
  }
  for (const bad of [
    "/admin/editorial-ranking-policy",
    "/admin/editorial-ranking-policy?profileId=science_news&profileId=science_news",
    "/admin/editorial-ranking-policy?profileId=../secrets",
  ]) {
    assert.equal((await serve(state.handler, bad)).status, 400);
  }
  assert.equal(
    (
      await serve(state.handler, "/admin/editorial-ranking-policy", "POST", {
        profileId: "science_news",
        expectedRevision: 0,
        settings,
        actorId: ACTOR,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await serve(
        state.handler,
        "/admin/editorial-ranking-policy",
        "POST",
        {
          profileId: "science_news",
          expectedRevision: 0,
          settings,
        },
        "https://attacker.example",
      )
    ).status,
    403,
  );
  assert.equal(state.opened, 3);
  assert.equal(
    (
      await serve(setup(true).handler, "/admin/editorial-ranking-policy", "POST", {
        profileId: "science_news",
        expectedRevision: 0,
        settings,
      })
    ).status,
    403,
  );
});

test("personally attributed publisher and event review APIs are metadata-only", async () => {
  const source = {
    sourceId: "science_feed",
    sourceRevision: 5,
    publisherGroup: "science_origin",
    quality: 4,
  };
  const factors = {
    eventId: "ca310002-2222-4222-8222-222222222222",
    profileId: "science_news",
    profileRevision: 1,
    policyRevision: 2,
    explanatoryValue: 4,
    visualizability: 5,
    risk: 1,
  };
  assert.deepEqual(validateNamedPublisherReviewWrite(source), source);
  assert.deepEqual(validateNamedEventFactorReviewWrite(factors), factors);
  const state = setup();
  assert.deepEqual(
    (await serve(state.handler, "/admin/editorial-publisher-review?sourceId=science_feed")).json,
    {
      sourceId: "science_feed",
      sourceRevision: 5,
      reviewed: false,
      publisherGroup: null,
      quality: null,
      approvedForPublication: false,
    },
  );
  assert.deepEqual(
    (
      await serve(
        state.handler,
        "/admin/editorial-event-factors?eventId=" + factors.eventId + "&profileId=science_news",
      )
    ).json,
    {
      eventId: factors.eventId,
      profileId: factors.profileId,
      profileRevision: 1,
      policyRevision: 2,
      reviewed: false,
      explanatoryValue: null,
      visualizability: null,
      risk: null,
      approvedForPublication: false,
    },
  );
  const p = await serve(state.handler, "/admin/editorial-publisher-review", "POST", source);
  const e = await serve(state.handler, "/admin/editorial-event-factors", "POST", factors);
  assert.equal(p.status, 200);
  assert.equal(e.status, 200);
  assert.deepEqual(e.json, { saved: true, approvedForPublication: false });
  assert.deepEqual(p.json, { saved: true, approvedForPublication: false });
  assert.ok(state.sql.some((x) => x.includes("named_publisher_review_commit")));
  assert.ok(state.sql.some((x) => x.includes("named_event_factor_review_commit")));
  assert.ok(state.sql.every((x) => !x.includes("science_origin")));
  assert.equal(state.opened, 4);
  assert.equal(state.closed, 4);
});

test("publisher and event factor reviews reject forged actors, invalid revisions and origin", async () => {
  const state = setup();
  const source = {
    sourceId: "science_feed",
    sourceRevision: 5,
    publisherGroup: "science_origin",
    quality: 4,
  };
  const factors = {
    eventId: "ca310002-2222-4222-8222-222222222222",
    profileId: "science_news",
    profileRevision: 1,
    policyRevision: 2,
    explanatoryValue: 4,
    visualizability: 5,
    risk: 1,
  };
  for (const payload of [
    { ...source, actorId: ACTOR },
    { ...source, quality: 6 },
    { ...source, publisherGroup: "invalid-group?" },
    { ...source, sourceRevision: 0 },
  ]) {
    assert.equal(validateNamedPublisherReviewWrite(payload), null);
    assert.equal(
      (await serve(state.handler, "/admin/editorial-publisher-review", "POST", payload)).status,
      400,
    );
  }
  for (const payload of [
    { ...factors, reviewerId: ACTOR },
    { ...factors, risk: 6 },
    { ...factors, policyRevision: 0 },
    { ...factors, eventId: "bad" },
  ]) {
    assert.equal(validateNamedEventFactorReviewWrite(payload), null);
    assert.equal(
      (await serve(state.handler, "/admin/editorial-event-factors", "POST", payload)).status,
      400,
    );
  }
  for (const path of [
    "/admin/editorial-publisher-review",
    "/admin/editorial-publisher-review?sourceId=science_feed&sourceId=science_feed",
    "/admin/editorial-event-factors?eventId=" + factors.eventId,
    "/admin/editorial-event-factors?eventId=" +
      factors.eventId +
      "&profileId=science_news&actorId=forged",
  ]) {
    assert.equal((await serve(state.handler, path)).status, 400);
  }
  assert.equal(
    (
      await serve(
        state.handler,
        "/admin/editorial-publisher-review",
        "POST",
        source,
        "https://attacker.invalid",
      )
    ).status,
    403,
  );
  assert.equal(
    (await serve(setup(true).handler, "/admin/editorial-event-factors", "POST", factors)).status,
    403,
  );
  assert.equal(state.opened, 4);
});
