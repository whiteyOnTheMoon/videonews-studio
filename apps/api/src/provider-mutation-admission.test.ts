import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type { Pool } from "pg";
import { AdminProviderConfiguration } from "./admin-provider-configuration.js";
import { ProviderMutationLimiter } from "./provider-mutation-limiter.js";
import { PostgresProviderMutationLimiter } from "./postgres-provider-mutation-limiter.js";

function request(): IncomingMessage {
  const payload = JSON.stringify({ action: "remove_key", provider: "openai" });
  return Object.assign(Readable.from([payload]), {
    url: "/admin/ai-providers",
    method: "POST",
    headers: {
      origin: "https://example.invalid",
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

function response(): ServerResponse & { code: number; body: string } {
  const res = {
    code: 0,
    body: "",
    setHeader(name: string, value: string) {
      void name;
      void value;
    },
    writeHead(code: number) {
      this.code = code;
    },
    end(body: string) {
      this.body = body;
    },
  };
  return res as unknown as ServerResponse & typeof res;
}

test("injected gate blocks authenticated repeat mutations before database", async () => {
  let mutations = 0;
  const handler = new AdminProviderConfiguration(
    { hasAdminSession: () => true, originAllowed: () => true },
    {
      list: async () => [],
      mutateWithAudit: async () => {
        mutations++;
      },
    },
    randomBytes(32),
    new ProviderMutationLimiter(() => 10_000, 1),
  );
  const first = response();
  await handler.handle(request(), first);
  assert.equal(first.code, 200);
  const second = response();
  await handler.handle(request(), second);
  assert.equal(second.code, 429);
  assert.deepEqual(JSON.parse(second.body), { error: "too_many_requests" });
  assert.equal(mutations, 1);
});

test("invalid session and origin remain forbidden before limiter invocation", async () => {
  let checks = 0;
  const handler = new AdminProviderConfiguration(
    { hasAdminSession: () => false, originAllowed: () => false },
    { list: async () => [], mutateWithAudit: async () => undefined },
    randomBytes(32),
    {
      allow: () => {
        checks++;
        return false;
      },
    },
  );
  const res = response();
  await handler.handle(request(), res);
  assert.equal(res.code, 401);
  assert.equal(checks, 0);
});

test("asynchronous database admission denies writes after shared quota is consumed", async () => {
  let slots = 0;
  let changes = 0;
  const pool = {
    async query() {
      slots++;
      return { rows: [{ allowed: slots <= 1 }] };
    },
  } as unknown as Pool;
  const handler = new AdminProviderConfiguration(
    { hasAdminSession: () => true, originAllowed: () => true },
    {
      list: async () => [],
      mutateWithAudit: async () => {
        changes++;
      },
    },
    randomBytes(32),
    new PostgresProviderMutationLimiter(pool),
  );
  const success = response();
  await handler.handle(request(), success);
  assert.equal(success.code, 200);
  const denied = response();
  await handler.handle(request(), denied);
  assert.equal(denied.code, 429);
  assert.equal(changes, 1);
  assert.equal(slots, 2);
});

test("database admission failure yields sanitized 503 without reading secret body", async () => {
  let reads = 0;
  const body = Readable.from(
    (async function* () {
      reads++;
      yield '{"action":"remove_key","provider":"openai"}';
    })(),
  );
  const req = Object.assign(body, {
    url: "/admin/ai-providers",
    method: "POST",
    headers: {
      origin: "https://example.invalid",
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
  let mutations = 0;
  const pool = {
    async query() {
      throw new Error("postgres://never-expose-this-fixture-secret");
    },
  } as unknown as Pool;
  const handler = new AdminProviderConfiguration(
    { hasAdminSession: () => true, originAllowed: () => true },
    {
      list: async () => [],
      mutateWithAudit: async () => {
        mutations++;
      },
    },
    randomBytes(32),
    new PostgresProviderMutationLimiter(pool),
  );
  const result = response();
  await handler.handle(req, result);
  assert.equal(result.code, 503);
  assert.deepEqual(JSON.parse(result.body), { error: "temporarily_unavailable" });
  assert.equal(reads, 0);
  assert.equal(mutations, 0);
  assert.ok(!result.body.includes("postgres://"));
});
