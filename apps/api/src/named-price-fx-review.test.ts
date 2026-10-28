import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  parseNamedPriceReview,
  PostgresNamedPriceReviewStore,
  NamedPriceFxReviewHttp,
} from "./named-price-fx-review.js";

const ID = "a4110001-0000-4000-8000-000000000001";
const RECEIPT = "a4110002-0000-4000-8000-000000000002";
const identity = { id: ID, username: "ci_admin", role: "admin" as const, authVersion: 0 };
const later = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const price = () => ({
  action: "review_price",
  provider: "openai",
  model: "some-verified-model",
  priceVersion: "reviewed_version_0001",
  inputMicroUsdPerMillion: "1000000",
  cachedMicroUsdPerMillion: "250000",
  outputMicroUsdPerMillion: "2000000",
  expiresAt: later(),
  sourceReference: "https://example.org/prices",
});
const fx = () => ({
  action: "review_fx",
  microEurPerMicroUsdNanos: "1150000000",
  expiresAt: later(),
  sourceReference: "https://example.org/rates",
});

test("price FX commands are exact, decimal and contain no activation, secrets or endpoints", () => {
  const validPrice = price();
  const validFx = fx();
  assert.deepEqual(parseNamedPriceReview(validPrice), validPrice);
  assert.deepEqual(parseNamedPriceReview(validFx), validFx);
  for (const invalid of [
    null,
    [],
    {},
    { ...price(), action: "enable" },
    { ...price(), apiKey: "secret" },
    { ...fx(), budget: 100 },
    { ...price(), provider: "injected" },
    { ...price(), model: "evil/model" },
    { ...price(), priceVersion: "short" },
    { ...price(), inputMicroUsdPerMillion: 1 },
    { ...price(), cachedMicroUsdPerMillion: "2000000" },
    { ...price(), inputMicroUsdPerMillion: "0", outputMicroUsdPerMillion: "0" },
    { ...price(), sourceReference: "http://example.org/prices" },
    { ...price(), sourceReference: "https://name:pass@example.org/rates" },
    { ...price(), expiresAt: "yesterday" },
    { ...fx(), microEurPerMicroUsdNanos: "0" },
    { ...fx(), microEurPerMicroUsdNanos: "10000000001" },
    { ...fx(), microEurPerMicroUsdNanos: "1.05" },
    { ...fx(), enabled: true },
  ])
    assert.equal(parseNamedPriceReview(invalid), null);
});

test("named price store uses parameterized SQL and sanitized return", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [{ id: RECEIPT }] };
    },
  } as unknown as Pick<Pool, "query">;
  const store = new PostgresNamedPriceReviewStore(pool);
  assert.equal(await store.record(price() as never, identity), RECEIPT);
  assert.equal(await store.record(fx() as never, identity), RECEIPT);
  assert.match(calls[0]!.sql, /admin_review_live_provider_price_as_editor/);
  assert.match(calls[1]!.sql, /admin_review_live_provider_fx_as_editor/);
  assert.deepEqual(calls[0]!.params.slice(0, 5), [
    ID,
    0,
    "openai",
    "some-verified-model",
    "reviewed_version_0001",
  ]);
  assert.deepEqual(calls[1]!.params.slice(0, 3), [ID, 0, "1150000000"]);
  await assert.rejects(
    store.record(price() as never, {
      ...identity,
      role: "editor",
    }),
    /unavailable/,
  );
  assert.equal(calls.length, 2);
});

test("named price store suppresses SQL credentials and unexpected receipts", async () => {
  const pool = {
    async query() {
      throw new Error("secret-admin-db-password");
    },
  } as unknown as Pick<Pool, "query">;
  await assert.rejects(
    new PostgresNamedPriceReviewStore(pool).record(fx() as never, identity),
    (e: Error) => e.message === "Named price review unavailable",
  );
});

function request(payload: unknown = fx(), origin = "https://studio.example.invalid") {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
    url: "/admin/ai-provider-pricing",
    method: "POST",
    headers: { origin, "content-type": "application/json" },
  }) as unknown as IncomingMessage;
}
function response() {
  const res = {
    code: 0,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    writeHead(code: number) {
      this.code = code;
    },
    end(value: string) {
      this.body = value;
    },
  };
  return res;
}

test("named review HTTP checks session, Origin and shared admission before database writes", async () => {
  let admissions = 0;
  let writes = 0;
  let authenticated = false;
  const handler = new NamedPriceFxReviewHttp(
    { authenticatedAdminIdentity: async () => (authenticated ? identity : null) },
    { originAllowed: (req) => req.headers.origin === "https://studio.example.invalid" },
    {
      record: async () => {
        writes++;
        return RECEIPT;
      },
    },
    {
      allow: async () => {
        admissions++;
        return true;
      },
    },
  );
  const unauthorized = response();
  await handler.handle(request(), unauthorized as unknown as ServerResponse);
  assert.equal(unauthorized.code, 401);
  assert.equal(admissions, 0);
  authenticated = true;
  const forbidden = response();
  await handler.handle(
    request(fx(), "https://forged.invalid"),
    forbidden as unknown as ServerResponse,
  );
  assert.equal(forbidden.code, 403);
  assert.equal(admissions, 0);
  const bad = response();
  await handler.handle(request({ ...fx(), enabled: true }), bad as unknown as ServerResponse);
  assert.equal(bad.code, 400);
  assert.equal(admissions, 1);
  const okay = response();
  await handler.handle(request(price()), okay as unknown as ServerResponse);
  assert.equal(okay.code, 200);
  assert.deepEqual(JSON.parse(okay.body), { reviewed: true, active: false, reviewId: RECEIPT });
  assert.equal(writes, 1);
  assert.equal(admissions, 2);
  assert.equal(okay.headers["Cache-Control"], "no-store");
});

test("denied or failing admission cannot persist reviewed prices", async () => {
  let writes = 0;
  for (const allow of [
    async () => false,
    async () => {
      throw new Error("private-secret");
    },
  ]) {
    const handler = new NamedPriceFxReviewHttp(
      { authenticatedAdminIdentity: async () => identity },
      { originAllowed: () => true },
      {
        record: async () => {
          writes++;
          return RECEIPT;
        },
      },
      { allow },
    );
    const res = response();
    await handler.handle(request(), res as unknown as ServerResponse);
    assert.ok(res.code === 429 || res.code === 503);
    assert.ok(!res.body.includes("private-secret"));
  }
  assert.equal(writes, 0);
});
