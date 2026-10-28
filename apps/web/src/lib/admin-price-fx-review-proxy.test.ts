import assert from "node:assert/strict";
import test from "node:test";
import {
  dormantPriceReviewProxy,
  parsePriceReviewBody,
  priceReviewProxyConfig,
} from "./admin-price-fx-review-proxy";

const ORIGIN = "https://studio.ap-pixels.com";
const CFG = { origin: ORIGIN, api: "http://api:4000" };
const COOKIE = "__Host-vns_editor=" + "a".repeat(64);
const UUID = "b4110002-0000-4000-8000-000000000002";
const later = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const command = () => ({
  action: "review_fx",
  microEurPerMicroUsdNanos: "1150000000",
  expiresAt: later(),
  sourceReference: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
});
const request = (body: unknown = command(), origin = ORIGIN, cookie = COOKIE) =>
  new Request(ORIGIN + "/api/admin/ai-provider-pricing", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
test("read-only by default and exact review grammar", () => {
  assert.equal(priceReviewProxyConfig({}), null);
  assert.deepEqual(parsePriceReviewBody(command()), command());
  for (const invalid of [
    {},
    null,
    { ...command(), action: "enable" },
    { ...command(), apiKey: "forbidden" },
    { ...command(), enabled: true },
    { ...command(), microEurPerMicroUsdNanos: 1000000000 },
    { ...command(), microEurPerMicroUsdNanos: "-1" },
    { ...command(), sourceReference: "http://not-allowed.invalid/path" },
  ])
    assert.equal(parsePriceReviewBody(invalid), null);
});

test("BFF requires named admin, exact origin, framing and no shared cookie", async () => {
  let upstreamWrites = 0;
  const fetcher = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/editor/me")) {
      return Response.json({ role: "editor" });
    }
    upstreamWrites++;
    throw new Error("must not send");
  }) as typeof fetch;
  assert.equal((await dormantPriceReviewProxy(request(), null, fetcher)).status, 404);
  assert.equal(
    (await dormantPriceReviewProxy(request(command(), "https://forged.invalid"), CFG, fetcher))
      .status,
    403,
  );
  assert.equal(
    (
      await dormantPriceReviewProxy(
        request(command(), ORIGIN, "__Host-vns_session=" + "b".repeat(64)),
        CFG,
        fetcher,
      )
    ).status,
    401,
  );
  assert.equal((await dormantPriceReviewProxy(request(), CFG, fetcher)).status, 403);
  assert.equal(upstreamWrites, 0);
});

test("named admin BFF forwards only reviewed snapshot, never exposes provider activation", async () => {
  const called: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    called.push(url);
    if (url.endsWith("/editor/me")) return Response.json({ role: "admin", username: "ci_admin" });
    assert.equal(url, CFG.api + "/admin/ai-provider-pricing");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Cookie"), COOKIE);
    assert.equal(new Headers(init?.headers).get("Origin"), ORIGIN);
    assert.deepEqual(JSON.parse(String(init?.body)), commandData);
    return Response.json({ reviewed: true, active: false, reviewId: UUID });
  }) as typeof fetch;
  const commandData = command();
  const response = await dormantPriceReviewProxy(request(commandData), CFG, fetcher);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reviewed: true, active: false, reviewId: UUID });
  assert.deepEqual(called, [CFG.api + "/editor/me", CFG.api + "/admin/ai-provider-pricing"]);
});

test("incorrect upstream evidence, redirect and SQL errors never appear to browser", async () => {
  for (const upstream of [
    Response.json({ reviewed: true, active: true, reviewId: UUID }),
    Response.json({ reviewed: true, active: false, reviewId: "not-uuid" }),
    new Response("secret-db-credentials", { status: 503 }),
    new Response("redirect", { status: 302, headers: { location: "https://evil.invalid" } }),
  ]) {
    const fetcher = (async (url: RequestInfo | URL) =>
      String(url).endsWith("/editor/me")
        ? Response.json({ role: "admin" })
        : upstream) as typeof fetch;
    const response = await dormantPriceReviewProxy(request(), CFG, fetcher);
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("secret-db-credentials"));
  }
});

test("malformed review data or forbidden framing cannot create a review", async () => {
  let writes = 0;
  const fetcher = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/editor/me")) return Response.json({ role: "admin" });
    writes++;
    return Response.json({ reviewed: true, active: false, reviewId: UUID });
  }) as typeof fetch;
  const invalid = await dormantPriceReviewProxy(
    request({ ...command(), enable: true }),
    CFG,
    fetcher,
  );
  assert.equal(invalid.status, 400);
  const tooLarge = await dormantPriceReviewProxy(
    request({ ...command(), sourceReference: "https://example.org/" + "x".repeat(1100) }),
    CFG,
    fetcher,
  );
  assert.equal(tooLarge.status, 400);
  const original = request();
  const headers = new Headers(original.headers);
  headers.set("Content-Encoding", "gzip");
  const encoded = new Request(original, { headers });
  assert.equal((await dormantPriceReviewProxy(encoded, CFG, fetcher)).status, 400);
  assert.equal(writes, 0);
});
