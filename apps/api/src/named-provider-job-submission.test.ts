import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { withProviderPromptKey } from "./provider-master-key-file.js";
import {
  parseNamedProviderJob,
  PostgresNamedProviderJobStore,
  NamedProviderJobSubmissionHttp,
} from "./named-provider-job-submission.js";

const ID = "a4710001-0000-4000-8000-000000000001";
const PRICE = "a4710002-0000-4000-8000-000000000002";
const JOB = "a4710003-0000-4000-8000-000000000003";
const identity = { id: ID, username: "ci_admin", role: "admin" as const, authVersion: 0 };
const valid = () => ({
  idempotencyKey: "ci_named_provider_job_key_00047",
  requestId: "ci_named_request_00047",
  provider: "openai",
  model: "reviewed-model-47",
  priceSnapshotId: PRICE,
  prompt: "Verified source evidence.",
  maxInputTokens: 100,
  maxOutputTokens: 32,
});
const key: typeof withProviderPromptKey = async <T>(
  callback: (key: Buffer) => T | Promise<T>,
): Promise<T> => {
  const secret = randomBytes(32);
  try {
    return await callback(secret);
  } finally {
    secret.fill(0);
  }
};

test("submission payload has exact contract and never contains activation", () => {
  assert.deepEqual(parseNamedProviderJob(valid()), valid());
  for (const item of [
    {},
    null,
    { ...valid(), budget: 1 },
    { ...valid(), action: "enable" },
    { ...valid(), apiKey: "never" },
    { ...valid(), provider: "unknown" },
    { ...valid(), model: "bad/model" },
    { ...valid(), idempotencyKey: "short" },
    { ...valid(), requestId: "short" },
    { ...valid(), priceSnapshotId: "bad" },
    { ...valid(), prompt: " " },
    { ...valid(), prompt: "a".repeat(32769) },
    { ...valid(), maxInputTokens: 0 },
    { ...valid(), maxInputTokens: 1 },
    { ...valid(), maxOutputTokens: 5000 },
  ]) {
    assert.equal(parseNamedProviderJob(item), null);
  }
});

test("named submission sends encrypted payload, author identity and bounded SQL only", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return { rows: [{ id: JOB }] };
    },
  } as unknown as Pick<Pool, "query">;
  const sealedKey = randomBytes(32);
  const store = new PostgresNamedProviderJobStore(db);
  assert.equal(await store.create(valid() as never, identity, sealedKey), JOB);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /admin_create_sealed_provider_job_as_editor/);
  assert.deepEqual(calls[0]!.params.slice(0, 7), [
    ID,
    0,
    valid().idempotencyKey,
    valid().requestId,
    "openai",
    "reviewed-model-47",
    PRICE,
  ]);
  assert.equal(calls[0]!.params.length, 13);
  assert.equal(
    calls[0]!.params.slice(10).every((x) => typeof x === "string"),
    true,
  );
  assert.equal(JSON.stringify(calls[0]).includes(valid().prompt), false);
  sealedKey.fill(0);
});

test("database errors are suppressed and non-admin identities rejected", async () => {
  const db = {
    async query() {
      throw new Error("postgres-private-password");
    },
  } as unknown as Pick<Pool, "query">;
  const store = new PostgresNamedProviderJobStore(db);
  const secret = randomBytes(32);
  await assert.rejects(
    store.create(valid() as never, identity, secret),
    /Named provider job unavailable/,
  );
  await assert.rejects(
    store.create(valid() as never, { ...identity, role: "editor" }, secret),
    /Named provider job unavailable/,
  );
  secret.fill(0);
});

function req(
  payload: unknown = valid(),
  origin = "https://studio.example.invalid",
): IncomingMessage {
  const raw = Buffer.from(JSON.stringify(payload));
  return Object.assign(Readable.from([raw]), {
    url: "/admin/ai-provider-jobs",
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "content-length": String(raw.length),
    },
  }) as unknown as IncomingMessage;
}
function response() {
  const record = { status: 0, output: "" };
  return Object.assign(record, {
    setHeader(_name: string, _value: string) {
      return this;
    },
    writeHead(status: number) {
      record.status = status;
    },
    end(body: string) {
      record.output = body;
    },
  }) as unknown as ServerResponse & { status: number; output: string };
}

function scenario(role: "admin" | "editor" | null = "admin", admit = true) {
  let writes = 0;
  let keyReads = 0;
  const handler = new NamedProviderJobSubmissionHttp(
    {
      async authenticatedAdminIdentity() {
        return role ? { ...identity, role } : null;
      },
    },
    { originAllowed: (request) => request.headers.origin === "https://studio.example.invalid" },
    {
      async create() {
        writes++;
        return JOB;
      },
    },
    {
      async allow() {
        return admit;
      },
    },
    async <T>(op: (secret: Buffer) => T | Promise<T>) => {
      keyReads++;
      return key(op);
    },
  );
  return { handler, writes: () => writes, keyReads: () => keyReads };
}

test("personal admin, origin and limiter are mandatory before key read", async () => {
  for (const [role, origin, admitted, code] of [
    [null, "https://studio.example.invalid", true, 401],
    ["editor", "https://studio.example.invalid", true, 401],
    ["admin", "https://untrusted.invalid", true, 403],
    ["admin", "https://studio.example.invalid", false, 429],
  ] as const) {
    const s = scenario(role, admitted);
    const res = response();
    await s.handler.handle(req(valid(), origin), res);
    assert.equal(res.status, code);
    assert.equal(s.writes(), 0);
    assert.equal(s.keyReads(), 0);
  }
});

test("valid request only records pending SQL intent, not Redis dispatch", async () => {
  const s = scenario();
  const res = response();
  assert.equal(await s.handler.handle(req(), res), true);
  assert.equal(res.status, 202);
  assert.deepEqual(JSON.parse(res.output), {
    accepted: true,
    enqueued: false,
    active: false,
    jobId: JOB,
  });
  assert.equal(s.writes(), 1);
  assert.equal(s.keyReads(), 1);
});

test("invalid body never reaches encryption or database", async () => {
  const s = scenario();
  const res = response();
  await s.handler.handle(req({ ...valid(), enable: true }), res);
  assert.equal(res.status, 400);
  assert.equal(s.keyReads(), 0);
  assert.equal(s.writes(), 0);
});
