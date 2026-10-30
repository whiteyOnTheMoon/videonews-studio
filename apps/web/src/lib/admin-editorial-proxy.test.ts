import assert from "node:assert/strict";
import test from "node:test";
import { dormantEditorialAdminProxy } from "./admin-editorial-proxy";

const config = { origin: "https://studio.example.invalid", api: "http://api:4000" };
const cookie = "__Host-vns_editor=" + "a".repeat(64);
const eventId = "ca300003-3333-4333-8333-333333333333";

function request(route: string, method = "GET", data?: unknown, origin = config.origin) {
  return new Request("https://studio.example.invalid" + route, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}
function backend(role = "admin") {
  const urls: string[] = [];
  const fetcher = (async (resource: string | URL | Request) => {
    const url = String(resource);
    urls.push(url);
    if (url.endsWith("/editor/me")) {
      return Response.json({ username: "ci_admin", role });
    }
    if (url.includes("editorial-profiles")) {
      return Response.json({ revision: 0, profiles: [] });
    }
    return Response.json({ events: [], nextRevision: 0 });
  }) as typeof fetch;
  return { fetcher, urls };
}

test("feature flag off, missing editor cookie and invalid method have no proxy side effects", async () => {
  const b = backend();
  const req = request("/api/admin/editorial-profiles");
  assert.equal((await dormantEditorialAdminProxy(req, "profiles", null, b.fetcher)).status, 404);
  const forbidden = new Request(req.url);
  assert.equal(
    (await dormantEditorialAdminProxy(forbidden, "profiles", config, b.fetcher)).status,
    401,
  );
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request("/api/admin/editorial-timeline", "POST"),
        "timeline",
        config,
        b.fetcher,
      )
    ).status,
    405,
  );
  assert.equal(b.urls.length, 0);
});

test("identity verified upstream, fixed target GET profiles and paginated audit lookup", async () => {
  const b = backend();
  const response = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-profiles"),
    "profiles",
    config,
    b.fetcher,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 0, profiles: [] });
  const exportResponse = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-checkpoints?eventId=" + eventId + "&after=0&limit=10"),
    "checkpoints",
    config,
    b.fetcher,
  );
  assert.equal(exportResponse.status, 200);
  assert.ok(b.urls.every((url) => url.startsWith(config.api + "/")));
  assert.ok(
    b.urls.includes(
      config.api + "/admin/editorial-checkpoints?eventId=" + eventId + "&after=0&limit=10",
    ),
  );
});

test("reviewer role, forged origin and oversized page query fail without an upstream write", async () => {
  const b = backend("reviewer");
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request("/api/admin/editorial-profiles"),
        "profiles",
        config,
        b.fetcher,
      )
    ).status,
    403,
  );
  const target = request(
    "/api/admin/editorial-profiles",
    "POST",
    { expectedRevision: 0, profiles: [] },
    "https://evil.example",
  );
  assert.equal(
    (await dormantEditorialAdminProxy(target, "profiles", config, b.fetcher)).status,
    403,
  );
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request("/api/admin/editorial-checkpoints?eventId=" + eventId + "&after=0&limit=101"),
        "checkpoints",
        config,
        b.fetcher,
      )
    ).status,
    400,
  );
  assert.ok(b.urls.every((url) => url.endsWith("/editor/me")));
});

test("checkpoint write accepts only an authenticated same-origin revision-bound command", async () => {
  const attempts: { url: string; method?: string; body?: string }[] = [];
  const fetcher = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = String(resource);
    attempts.push({ url, method: init?.method, body: init?.body as string | undefined });
    if (url.endsWith("/editor/me")) return Response.json({ role: "admin" });
    if (url.endsWith("/admin/editorial-checkpoints")) {
      return Response.json({ saved: true, revision: 2, approvedForPublication: false });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
  const command = {
    eventId,
    expectedRevision: 1,
    stage: "claim_review",
    outcome: "needs_review",
    artifactSha256: "a".repeat(64),
    reasonCodes: ["insufficient_independence"],
    score: null,
  };
  const saved = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-checkpoints", "POST", command),
    "checkpoints",
    config,
    fetcher,
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    saved: true,
    revision: 2,
    approvedForPublication: false,
  });
  const upstream = attempts.find(
    (entry) => entry.url === config.api + "/admin/editorial-checkpoints" && entry.method === "POST",
  );
  assert.ok(upstream);
  assert.deepEqual(JSON.parse(upstream.body!), command);

  const before = attempts.length;
  for (const data of [
    { ...command, actorId: "forged" },
    { ...command, reasonCodes: ["not Allowed"] },
    { ...command, expectedRevision: -1 },
    { ...command, approvedForPublication: true },
  ]) {
    assert.equal(
      (
        await dormantEditorialAdminProxy(
          request("/api/admin/editorial-checkpoints", "POST", data),
          "checkpoints",
          config,
          fetcher,
        )
      ).status,
      400,
    );
  }
  assert.ok(attempts.length >= before);
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request("/api/admin/editorial-checkpoints", "POST", command, "https://evil.invalid"),
        "checkpoints",
        config,
        fetcher,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request("/api/admin/editorial-checkpoints?eventId=" + eventId, "POST", command),
        "checkpoints",
        config,
        fetcher,
      )
    ).status,
    400,
  );
});

test("P2-10 personal story timeline writes audited events but cannot publish", async () => {
  const storyId = "ca310002-2222-4222-8222-222222222222";
  const created = "ca310004-4444-4444-8444-444444444444";
  const calls: string[] = [];
  const mock = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = String(resource);
    calls.push(url);
    if (url.endsWith("/editor/me")) return Response.json({ role: "admin" });
    if (url.endsWith("/admin/editorial-timeline") && init?.method === "POST") {
      return Response.json({ eventId: created, approvedForPublication: false });
    }
    return Response.json({ error: "unexpected" }, { status: 503 });
  }) as typeof fetch;
  const command = {
    storyId,
    eventKind: "claim_rejected",
    referenceUri: "https://example.org/review",
    documentSha256: "b".repeat(64),
    details: {
      summary: "Claim rejected because its numerical evidence was not corroborated.",
      reasonCodes: ["independent_evidence_required"],
    },
  };
  const result = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-timeline", "POST", command),
    "timeline",
    config,
    mock,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    eventId: created,
    approvedForPublication: false,
  });
  const count = calls.length;
  for (const bad of [
    { ...command, actor: "forged" },
    { ...command, approvedForPublication: true },
    { ...command, documentSha256: "bad" },
    { ...command, eventKind: "publish" },
    { ...command, details: { ...command.details, apiToken: "private" } },
  ]) {
    assert.equal(
      (
        await dormantEditorialAdminProxy(
          request("/api/admin/editorial-timeline", "POST", bad),
          "timeline",
          config,
          mock,
        )
      ).status,
      400,
    );
  }
  assert.equal(calls.length, count);
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request("/api/admin/editorial-timeline", "POST", command, "https://evil.invalid"),
        "timeline",
        config,
        mock,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request("/api/admin/editorial-timeline?storyId=" + storyId, "POST", command),
        "timeline",
        config,
        mock,
      )
    ).status,
    400,
  );
});

test("ranked feed BFF is personal, read-only and rejects forged metadata", async () => {
  const candidate = {
    eventId,
    profileId: "science_news",
    profileRevision: 1,
    headline: "Synthetic science briefing awaiting reviewer",
    score: 42,
    articleCount: 2,
    sourceCount: 1,
    reasons: ["metadata_candidate_only", "independent_verification_required"],
    rankedAt: "2026-10-28T12:00:00.000Z",
    approvedForPublication: false,
  };
  let upstreamCalls = 0;
  const upstream = (async (resource: string | URL | Request) => {
    if (String(resource).endsWith("/editor/me")) return Response.json({ role: "admin" });
    upstreamCalls++;
    return Response.json({ candidates: [candidate], metadataOnly: true });
  }) as typeof fetch;
  const url = "/api/admin/editorial-ranked-events?limit=25";
  const read = await dormantEditorialAdminProxy(request(url), "ranked-events", config, upstream);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { candidates: [candidate], metadataOnly: true });
  assert.equal(upstreamCalls, 1);
  for (const bad of [
    "/api/admin/editorial-ranked-events",
    "/api/admin/editorial-ranked-events?limit=100",
    "/api/admin/editorial-ranked-events?limit=25&actor=forged",
    "/api/admin/editorial-ranked-events?limit=25&limit=25",
  ]) {
    assert.equal(
      (await dormantEditorialAdminProxy(request(bad), "ranked-events", config, upstream)).status,
      400,
    );
  }
  assert.equal(
    (await dormantEditorialAdminProxy(request(url, "POST", {}), "ranked-events", config, upstream))
      .status,
    405,
  );
  assert.equal(upstreamCalls, 1);
  const forged = (async (resource: string | URL | Request) => {
    if (String(resource).endsWith("/editor/me")) return Response.json({ role: "admin" });
    return Response.json({
      candidates: [{ ...candidate, approvedForPublication: true, internalSecret: "leaked" }],
      metadataOnly: true,
    });
  }) as typeof fetch;
  assert.equal(
    (await dormantEditorialAdminProxy(request(url), "ranked-events", config, forged)).status,
    503,
  );
});

test("named ranking policy BFF enforces personal editor, origin, exact fields and revision", async () => {
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
  const calls: { url: string; body?: string }[] = [];
  const upstream = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, body: init?.body as string | undefined });
    if (target.endsWith("/editor/me")) return Response.json({ role: "admin" });
    if (target.includes("/admin/editorial-ranking-policy?profileId="))
      return Response.json({
        profileId: "science_news",
        profileRevision: 1,
        policyRevision: 0,
        settings: null,
        productionActive: false,
      });
    if (target.endsWith("/admin/editorial-ranking-policy"))
      return Response.json({ saved: true, policyRevision: 1, productionActive: false });
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  const read = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-ranking-policy?profileId=science_news"),
    "ranking-policy",
    config,
    upstream,
  );
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), {
    profileId: "science_news",
    profileRevision: 1,
    policyRevision: 0,
    settings: null,
    productionActive: false,
  });
  const saved = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-ranking-policy", "POST", {
      profileId: "science_news",
      expectedRevision: 0,
      settings,
    }),
    "ranking-policy",
    config,
    upstream,
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    saved: true,
    policyRevision: 1,
    productionActive: false,
  });
  assert.ok(
    calls.some(
      (call) =>
        call.url.endsWith("/admin/editorial-ranking-policy") &&
        !!call.body &&
        !call.body.includes("reviewerId"),
    ),
  );
  const total = calls.length;
  for (const bad of [
    { profileId: "science_news", expectedRevision: 0, settings: { ...settings, riskWeight: 101 } },
    { profileId: "science_news", expectedRevision: 0, settings: { ...settings, token: "forged" } },
    { profileId: "science_news", expectedRevision: 0, settings, reviewerId: "forged" },
    { profileId: "science_news", expectedRevision: -1, settings },
  ])
    assert.equal(
      (
        await dormantEditorialAdminProxy(
          request("/api/admin/editorial-ranking-policy", "POST", bad),
          "ranking-policy",
          config,
          upstream,
        )
      ).status,
      400,
    );
  for (const url of [
    "/api/admin/editorial-ranking-policy",
    "/api/admin/editorial-ranking-policy?profileId=../private",
    "/api/admin/editorial-ranking-policy?profileId=science_news&actor=forged",
    "/api/admin/editorial-ranking-policy?profileId=science_news&profileId=another",
  ])
    assert.equal(
      (await dormantEditorialAdminProxy(request(url), "ranking-policy", config, upstream)).status,
      400,
    );
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request(
          "/api/admin/editorial-ranking-policy",
          "POST",
          { profileId: "science_news", expectedRevision: 0, settings },
          "https://evil.example",
        ),
        "ranking-policy",
        config,
        upstream,
      )
    ).status,
    403,
  );
  assert.equal(calls.length, total);
});

test("source and event metadata reviews route only through same-origin personal BFF", async () => {
  const id = "ca310002-2222-4222-8222-222222222222";
  const source = {
    sourceId: "science_feed",
    sourceRevision: 5,
    publisherGroup: "science_origin",
    quality: 4,
  };
  const factors = {
    eventId: id,
    profileId: "science_news",
    profileRevision: 1,
    policyRevision: 2,
    explanatoryValue: 4,
    visualizability: 5,
    risk: 1,
  };
  const calls: { url: string; method?: string; body?: string }[] = [];
  const upstream = (async (resource: string | URL | Request, init?: RequestInit) => {
    const url = String(resource);
    calls.push({ url, method: init?.method, body: init?.body as string | undefined });
    if (url.endsWith("/editor/me")) return Response.json({ role: "admin" });
    if (url.includes("/admin/editorial-publisher-review?"))
      return Response.json({
        sourceId: "science_feed",
        sourceRevision: 5,
        reviewed: false,
        publisherGroup: null,
        quality: null,
        approvedForPublication: false,
      });
    if (url.includes("/admin/editorial-event-factors?"))
      return Response.json({
        eventId: id,
        profileId: "science_news",
        profileRevision: 1,
        policyRevision: 2,
        reviewed: false,
        explanatoryValue: null,
        visualizability: null,
        risk: null,
        approvedForPublication: false,
      });
    return Response.json({ saved: true, approvedForPublication: false });
  }) as typeof fetch;
  const a = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-publisher-review?sourceId=science_feed"),
    "publisher-review",
    config,
    upstream,
  );
  assert.equal(a.status, 200);
  const b = await dormantEditorialAdminProxy(
    request("/api/admin/editorial-event-factors?eventId=" + id + "&profileId=science_news"),
    "event-factors",
    config,
    upstream,
  );
  assert.equal(b.status, 200);
  const writes = [
    await dormantEditorialAdminProxy(
      request("/api/admin/editorial-publisher-review", "POST", source),
      "publisher-review",
      config,
      upstream,
    ),
    await dormantEditorialAdminProxy(
      request("/api/admin/editorial-event-factors", "POST", factors),
      "event-factors",
      config,
      upstream,
    ),
  ];
  for (const w of writes) {
    assert.equal(w.status, 200);
    assert.deepEqual(await w.json(), { saved: true, approvedForPublication: false });
  }
  assert.ok(
    calls.some(
      (call) =>
        call.url.endsWith("/admin/editorial-publisher-review") &&
        call.method === "POST" &&
        !!call.body &&
        !call.body.includes("reviewerId"),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.url.endsWith("/admin/editorial-event-factors") &&
        call.method === "POST" &&
        !!call.body &&
        !call.body.includes("reviewerId"),
    ),
  );
  const count = calls.length;
  for (const bad of [
    { ...source, reviewerId: "forged" },
    { ...source, quality: 7 },
    { ...source, sourceRevision: 0 },
  ]) {
    assert.equal(
      (
        await dormantEditorialAdminProxy(
          request("/api/admin/editorial-publisher-review", "POST", bad),
          "publisher-review",
          config,
          upstream,
        )
      ).status,
      400,
    );
  }
  for (const bad of [
    { ...factors, actorId: "forged" },
    { ...factors, risk: 6 },
    { ...factors, policyRevision: 0 },
  ]) {
    assert.equal(
      (
        await dormantEditorialAdminProxy(
          request("/api/admin/editorial-event-factors", "POST", bad),
          "event-factors",
          config,
          upstream,
        )
      ).status,
      400,
    );
  }
  for (const url of [
    "/api/admin/editorial-publisher-review",
    "/api/admin/editorial-publisher-review?sourceId=../forged",
    "/api/admin/editorial-event-factors?eventId=" + id,
    "/api/admin/editorial-event-factors?eventId=" + id + "&profileId=science_news&actor=forged",
  ])
    assert.equal(
      (
        await dormantEditorialAdminProxy(
          request(url),
          url.includes("publisher") ? "publisher-review" : "event-factors",
          config,
          upstream,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        request(
          "/api/admin/editorial-publisher-review",
          "POST",
          source,
          "https://attacker.invalid",
        ),
        "publisher-review",
        config,
        upstream,
      )
    ).status,
    403,
  );
  assert.equal(calls.length, count);
});
