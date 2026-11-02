import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { dormantEditorialAdminProxy } from "../apps/web/src/lib/admin-editorial-proxy.ts";
import { parseRankedCandidatePage } from "../apps/web/src/app/admin/editorial-ranked-events.tsx";

const ORIGIN = "https://studio.example.invalid";
const API = "http://api:4000";
const COOKIE = "__Host-vns_editor=" + "a".repeat(64);
const CONFIG = { origin: ORIGIN, api: API };

/**
 * Exercise the actual Web BFF against the real personal Admin API handler
 * and the previously populated disposable PostgreSQL ranking table.
 * Only the synthetic auth-cookie lookup is emulated: DB identity,
 * named ranking SQL, API parsing and BFF parsing all execute for real.
 */
export async function verifyWebRankedFeedBridge(handler, expectedStatus = 200) {
  if (
    process.env.CI !== "true" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.VNS_P2_ISOLATED_PORT_TEST !== "true"
  ) {
    throw new Error("Web-to-API ranking test requires disposable GitHub CI");
  }

  let profileRequests = 0;
  let rankedApiRequests = 0;
  const backend = async (target, init = {}) => {
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "manual");
    const url = String(target);
    if (url === API + "/editor/me") {
      profileRequests++;
      assert.equal(init.headers.Cookie, COOKIE);
      return Response.json({ username: "ci_port_source", role: "admin" });
    }
    assert.equal(url, API + "/admin/editorial-ranked-events?limit=25");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Cookie, COOKIE);
    rankedApiRequests++;

    const req = Object.assign(Readable.from([""]), {
      url: "/admin/editorial-ranked-events?limit=25",
      method: "GET",
      headers: { origin: ORIGIN, cookie: COOKIE },
    });
    const raw = { status: 0, body: "", headers: {} };
    raw.setHeader = function (key, value) {
      this.headers[key.toLowerCase()] = value;
    };
    raw.writeHead = function (code) {
      this.status = code;
    };
    raw.end = function (body) {
      this.body = body ?? "";
    };
    assert.equal(await handler.handle(req, raw), true);
    assert.ok(raw.status >= 200 && raw.status <= 599);
    return new Response(raw.body, {
      status: raw.status,
      headers: raw.headers,
    });
  };

  function webRequest(
    path = "/api/admin/editorial-ranked-events?limit=25",
    method = "GET",
    cookie = COOKIE,
  ) {
    return new Request(ORIGIN + path, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
  }

  const result = await dormantEditorialAdminProxy(webRequest(), "ranked-events", CONFIG, backend);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  if (expectedStatus === "revoked") {
    assert.ok([401, 403, 503].includes(result.status));
  } else {
    assert.equal(result.status, expectedStatus);
  }
  const body = await result.json();
  if (expectedStatus === 200) {
    assert.equal(body.metadataOnly, true);
    const displayed = parseRankedCandidatePage(body);
    assert.ok(displayed && displayed.length === 1);
    assert.equal(displayed[0].profileId, "science_news");
    assert.equal(displayed[0].articleCount, 3);
    assert.equal(displayed[0].sourceCount, 3);
    assert.equal(displayed[0].approvedForPublication, false);
    assert.ok(displayed[0].reasons.includes("independent_verification_required"));
  } else {
    assert.ok(!JSON.stringify(body).includes("science_news"));
    assert.equal(parseRankedCandidatePage(body), null);
  }
  assert.equal(profileRequests, 1);
  assert.equal(rankedApiRequests, 1);

  const before = [profileRequests, rankedApiRequests];
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        webRequest("/api/admin/editorial-ranked-events?limit=25", "POST"),
        "ranked-events",
        CONFIG,
        backend,
      )
    ).status,
    405,
  );
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        webRequest("/api/admin/editorial-ranked-events?limit=25&limit=25"),
        "ranked-events",
        CONFIG,
        backend,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await dormantEditorialAdminProxy(
        webRequest("/api/admin/editorial-ranked-events?limit=25", "GET", "invalid-cookie"),
        "ranked-events",
        CONFIG,
        backend,
      )
    ).status,
    401,
  );
  assert.deepEqual([profileRequests, rankedApiRequests], before);
}
