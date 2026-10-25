import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type { Pool } from "pg";
import { AdminProviderConfiguration } from "./admin-provider-configuration.js";
import { PostgresProviderConfigStore } from "./postgres-provider-config-store.js";

const ORIGIN = "https://studio.example.invalid";
const SYNTHETIC_KEY = "sk-fixture-p1-09-not-real-credential-12345";

function request(
  method: string,
  payload?: unknown,
  overrides: Record<string, string> = {},
): IncomingMessage {
  return Object.assign(Readable.from([payload === undefined ? "" : JSON.stringify(payload)]), {
    method,
    url: "/admin/ai-providers",
    headers: {
      cookie: "synthetic-admin-session",
      origin: ORIGIN,
      "content-type": "application/json",
      ...overrides,
    },
  }) as unknown as IncomingMessage;
}

function response(): ServerResponse & { status: number; payload: string } {
  const result = {
    status: 0,
    payload: "",
    setHeader(name: string, value: string) {
      void name;
      void value;
    },
    writeHead(status: number) {
      this.status = status;
    },
    end(value: string) {
      this.payload = value;
    },
  };
  return result as unknown as ServerResponse & typeof result;
}

function fixture() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("admin_list_ai_providers")) {
        return {
          rows: [
            { provider: "openai", selectedModel: "gpt-6.1-sol", configured: false },
            { provider: "google_gemini", selectedModel: "gemini-3.8-flash-tts", configured: false },
          ],
        };
      }
      if (sql.includes("admin_mutate_ai_provider")) return { rows: [] };
      throw new Error("Unexpected SQL in isolated test");
    },
  } as unknown as Pool;
  const auth = {
    hasAdminSession(req: IncomingMessage) {
      return req.headers.cookie === "synthetic-admin-session";
    },
    originAllowed(req: IncomingMessage) {
      return req.headers.origin === ORIGIN;
    },
  };
  const key = randomBytes(32);
  const handler = new AdminProviderConfiguration(auth, new PostgresProviderConfigStore(pool), key);
  return { handler, calls, key };
}

test("dormant API contract and PostgreSQL adapter compose for secret-free GET", async () => {
  const { handler, calls, key } = fixture();
  try {
    const res = response();
    assert.equal(await handler.handle(request("GET"), res), true);
    assert.equal(res.status, 200);
    const data: unknown = JSON.parse(res.payload);
    assert.deepEqual(data, {
      providers: [
        { provider: "openai", selectedModel: "gpt-6.1-sol", configured: false, active: false },
        { provider: "google_gemini", selectedModel: "gemini-3.8-flash-tts", configured: false, active: false },
      ],
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.sql ?? "", /admin_list_ai_providers/);
  } finally {
    key.fill(0);
  }
});

test("synthetic key is sealed before the audited SQL mutation boundary", async () => {
  const { handler, calls, key } = fixture();
  try {
    const res = response();
    await handler.handle(
      request("POST", { action: "set_key", provider: "openai", apiKey: SYNTHETIC_KEY }),
      res,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.payload), { saved: true, active: false });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.match(call?.sql ?? "", /admin_mutate_ai_provider/);
    assert.deepEqual(call?.values.slice(0, 3), ["openai", "set_key", null]);
    assert.ok(Buffer.isBuffer(call?.values[3]));
    assert.ok(Buffer.isBuffer(call?.values[4]));
    assert.ok(Buffer.isBuffer(call?.values[5]));
    assert.equal((call?.values[3] as Buffer).length, 12);
    assert.equal((call?.values[5] as Buffer).length, 16);
    assert.ok(!JSON.stringify(call).includes(SYNTHETIC_KEY));
    assert.ok(!res.payload.includes(SYNTHETIC_KEY));
  } finally {
    key.fill(0);
  }
});

test("unauthorized, forged-origin and forbidden activation never reach SQL", async () => {
  const { handler, calls, key } = fixture();
  try {
    const cases: Array<[IncomingMessage, number]> = [
      [request("POST", { action: "remove_key", provider: "openai" }, { cookie: "invalid" }), 401],
      [request("POST", { action: "remove_key", provider: "openai" }, { origin: "https://evil.invalid" }), 403],
      [request("POST", { action: "enable", provider: "openai" }), 400],
    ];
    for (const [req, expected] of cases) {
      const res = response();
      await handler.handle(req, res);
      assert.equal(res.status, expected);
      assert.ok(!res.payload.includes(SYNTHETIC_KEY));
    }
    assert.equal(calls.length, 0);
  } finally {
    key.fill(0);
  }
});

test("adapter SQL errors remain sanitized across the composed boundary", async () => {
  const key = randomBytes(32);
  try {
    const pool = {
      async query() {
        throw new Error("private-host-and-password-do-not-expose");
      },
    } as unknown as Pool;
    const handler = new AdminProviderConfiguration(
      {
        hasAdminSession: () => true,
        originAllowed: () => true,
      },
      new PostgresProviderConfigStore(pool),
      key,
    );
    for (const method of ["GET", "POST"]) {
      const res = response();
      await handler.handle(request(method, { action: "remove_key", provider: "openai" }), res);
      assert.equal(res.status, 503);
      assert.deepEqual(JSON.parse(res.payload), { error: "temporarily_unavailable" });
      assert.ok(!res.payload.includes("private-host"));
    }
  } finally {
    key.fill(0);
  }
});
