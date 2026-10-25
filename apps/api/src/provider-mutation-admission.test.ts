import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { AdminProviderConfiguration } from "./admin-provider-configuration.js";
import { ProviderMutationLimiter } from "./provider-mutation-limiter.js";

function request(): IncomingMessage {
  return Object.assign(Readable.from(['{"action":"remove_key","provider":"openai"}']), {
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
    { allow: () => { checks++; return false; } },
  );
  const res = response();
  await handler.handle(request(), res);
  assert.equal(res.code, 401);
  assert.equal(checks, 0);
});
