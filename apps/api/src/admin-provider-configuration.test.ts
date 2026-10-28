import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  AdminProviderConfiguration,
  parseProviderAdminCommand,
  validatePublicProviderList,
  type ProviderConfigStore,
  type ProviderMutation,
} from "./admin-provider-configuration.js";
import { unsealProviderApiKey } from "./provider-credential-crypto.js";

const ORIGIN = "https://studio.example.invalid";
const MASTER_KEY = randomBytes(32);
const EXAMPLE_KEY = "sk-synthetic-fixture-not-an-actual-secret-12345";

function fakeRequest(
  method: string,
  body: unknown = undefined,
  headers: Record<string, string> = {},
): IncomingMessage {
  const input = body === undefined ? "" : JSON.stringify(body);
  return Object.assign(Readable.from([input]), {
    url: "/admin/ai-providers",
    method,
    headers: {
      cookie: "session-fixture",
      origin: ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
  }) as unknown as IncomingMessage;
}

function fakeResponse(): ServerResponse & {
  code: number;
  payload: string;
  responseHeaders: Record<string, string>;
} {
  const result = {
    code: 0,
    payload: "",
    responseHeaders: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.responseHeaders[name.toLowerCase()] = value;
    },
    writeHead(code: number) {
      this.code = code;
    },
    end(value: string) {
      this.payload = value;
    },
  };
  return result as unknown as ServerResponse & typeof result;
}

function createFixtureStore() {
  const changes: ProviderMutation[] = [];
  const store: ProviderConfigStore = {
    async list() {
      return [
        { provider: "openai", selectedModel: "gpt-6.1-sol", configured: false },
        {
          provider: "google_gemini",
          selectedModel: "gemini-3.8-flash-tts",
          configured: false,
        },
      ];
    },
    async mutateWithAudit(change) {
      changes.push(change);
    },
  };
  return { store, changes };
}

const auth = {
  hasAdminSession(request: IncomingMessage) {
    return request.headers.cookie === "session-fixture";
  },
  originAllowed(request: IncomingMessage) {
    return request.headers.origin === ORIGIN;
  },
};

test("admin-only GET returns precisely two provider statuses, never credential details", async () => {
  const { store } = createFixtureStore();
  const config = new AdminProviderConfiguration(auth, store, MASTER_KEY);
  const response = fakeResponse();
  assert.equal(await config.handle(fakeRequest("GET"), response), true);
  assert.equal(response.code, 200);
  assert.deepEqual(JSON.parse(response.payload), {
    providers: [
      { provider: "openai", selectedModel: "gpt-6.1-sol", configured: false, active: false },
      {
        provider: "google_gemini",
        selectedModel: "gemini-3.8-flash-tts",
        configured: false,
        active: false,
      },
    ],
  });
  assert.equal(response.responseHeaders["cache-control"], "no-store");
  assert.equal(response.responseHeaders["x-content-type-options"], "nosniff");
});

test("unauthorized access or wrong origin never invokes the store", async () => {
  let called = false;
  const never: ProviderConfigStore = {
    async list() {
      called = true;
      throw new Error("secret internal DB error");
    },
    async mutateWithAudit() {
      called = true;
      throw new Error("secret internal DB error");
    },
  };
  const admin = new AdminProviderConfiguration(auth, never, MASTER_KEY);
  for (const method of ["GET", "POST"]) {
    const req = fakeRequest(
      method,
      { action: "remove_key", provider: "openai" },
      {
        cookie: "invalid",
      },
    );
    const res = fakeResponse();
    assert.equal(await admin.handle(req, res), true);
    assert.equal(res.code, 401);
    assert.ok(!res.payload.includes("secret"));
  }
  const res = fakeResponse();
  await admin.handle(
    fakeRequest(
      "POST",
      { action: "remove_key", provider: "openai" },
      {
        origin: "https://attacker.example",
      },
    ),
    res,
  );
  assert.equal(res.code, 403);
  assert.equal(called, false);
});

test("key rotation passes only sealed data to an audited storage boundary", async () => {
  const { store, changes } = createFixtureStore();
  const config = new AdminProviderConfiguration(auth, store, MASTER_KEY);
  const response = fakeResponse();
  const sent = await config.handle(
    fakeRequest("POST", { action: "set_key", provider: "openai", apiKey: EXAMPLE_KEY }),
    response,
  );
  assert.equal(sent, true);
  assert.equal(response.code, 200);
  assert.deepEqual(JSON.parse(response.payload), { saved: true, active: false });
  assert.equal(changes.length, 1);
  const change = changes[0];
  assert.equal(change?.action, "set_key");
  assert.equal(change?.provider, "openai");
  assert.ok(change?.sealedKey);
  assert.ok(!JSON.stringify(change).includes(EXAMPLE_KEY));
  assert.equal(unsealProviderApiKey("openai", change.sealedKey, MASTER_KEY), EXAMPLE_KEY);
  assert.ok(!response.payload.includes(EXAMPLE_KEY));
  assert.ok(!response.payload.includes(change.sealedKey.ciphertext));

  const changed = fakeResponse();
  await config.handle(
    fakeRequest("POST", { action: "set_key", provider: "openai", apiKey: EXAMPLE_KEY }),
    changed,
  );
  assert.equal(changed.code, 200);
  assert.notDeepEqual(changes[0]?.sealedKey, changes[1]?.sealedKey);
});

test("remove key and model selection require exact syntactic contracts", async () => {
  const { store, changes } = createFixtureStore();
  const config = new AdminProviderConfiguration(auth, store, MASTER_KEY);
  for (const body of [
    { action: "remove_key", provider: "google_gemini" },
    { action: "set_model", provider: "openai", model: "gpt-6-luna" },
  ]) {
    const response = fakeResponse();
    await config.handle(fakeRequest("POST", body), response);
    assert.equal(response.code, 200);
  }
  assert.deepEqual(changes, [
    { action: "remove_key", provider: "google_gemini" },
    { action: "set_model", provider: "openai", selectedModel: "gpt-6-luna" },
  ]);
});

test("invalid provider actions, malformed model and key-bearing GET data fail closed", async () => {
  const { store, changes } = createFixtureStore();
  const config = new AdminProviderConfiguration(auth, store, MASTER_KEY);
  for (const body of [
    {},
    null,
    [],
    { action: "enable", provider: "openai" },
    { action: "set_key", provider: "other", apiKey: EXAMPLE_KEY },
    { action: "set_key", provider: "openai", apiKey: "short" },
    { action: "set_key", provider: "openai", apiKey: EXAMPLE_KEY, extra: true },
    { action: "set_model", provider: "openai", model: "invalid model" },
    { action: "set_model", provider: "google_gemini", model: "bad/model" },
    { action: "set_model", provider: "openai", model: "https://bad.example" },
    { action: "set_model", provider: "openai", model: "x".repeat(81) },
    { action: "set_model", provider: "openai", model: "gpt-6.1-sol", apiKey: EXAMPLE_KEY },
  ]) {
    assert.equal(parseProviderAdminCommand(body), null);
    const response = fakeResponse();
    await config.handle(fakeRequest("POST", body), response);
    assert.equal(response.code, 400);
  }
  assert.equal(changes.length, 0);
  assert.throws(
    () =>
      validatePublicProviderList([
        { provider: "openai", selectedModel: "gpt-6.1-sol", configured: true, apiKey: EXAMPLE_KEY },
        { provider: "google_gemini", selectedModel: "gemini-3.8-flash-tts", configured: false },
      ]),
    /Invalid provider/,
  );
});

test("unsupported methods, invalid body encoding, oversize data and store errors are sanitized", async () => {
  const { store } = createFixtureStore();
  const config = new AdminProviderConfiguration(auth, store, MASTER_KEY);
  const badMethod = fakeResponse();
  await config.handle(fakeRequest("PUT"), badMethod);
  assert.equal(badMethod.code, 405);

  const badContentType = fakeResponse();
  await config.handle(
    fakeRequest(
      "POST",
      { action: "remove_key", provider: "openai" },
      {
        "content-type": "text/plain",
      },
    ),
    badContentType,
  );
  assert.equal(badContentType.code, 400);

  const huge = fakeResponse();
  await config.handle(
    fakeRequest("POST", {
      action: "set_key",
      provider: "openai",
      apiKey: EXAMPLE_KEY,
      junk: "x".repeat(1500),
    }),
    huge,
  );
  assert.equal(huge.code, 400);

  const broken: ProviderConfigStore = {
    async list() {
      throw new Error("database-host-secret-redacted");
    },
    async mutateWithAudit() {
      throw new Error("database-host-secret-redacted");
    },
  };
  const failed = new AdminProviderConfiguration(auth, broken, MASTER_KEY);
  for (const method of ["GET", "POST"]) {
    const response = fakeResponse();
    await failed.handle(
      fakeRequest(method, { action: "remove_key", provider: "openai" }),
      response,
    );
    assert.equal(response.code, 503);
    assert.ok(!response.payload.includes("database-host"));
  }
  assert.throws(
    () => new AdminProviderConfiguration(auth, store, randomBytes(16)),
    /Invalid provider encryption/,
  );
  const unrelated = fakeRequest("GET");
  unrelated.url = "/admin/unrelated";
  assert.equal(await config.handle(unrelated, fakeResponse()), false);
});

test("strict provider mutation body parsing rejects mismatched lengths and invalid UTF-8", async () => {
  const { store, changes } = createFixtureStore();
  const config = new AdminProviderConfiguration(auth, store, MASTER_KEY);
  const valid = JSON.stringify({ action: "remove_key", provider: "openai" });
  const invalidUtf8 = Buffer.concat([Buffer.from(valid, "utf8"), Buffer.from([0xff])]);
  const samples: Array<{ bytes: Buffer; headers: Record<string, string> }> = [
    { bytes: Buffer.from(valid), headers: { "content-length": "1" } },
    { bytes: Buffer.from(valid), headers: { "content-length": "999" } },
    { bytes: Buffer.from(valid), headers: { "content-length": "0001" } },
    { bytes: Buffer.from(valid), headers: { "content-length": "1025" } },
    { bytes: Buffer.from(valid), headers: { "content-encoding": "gzip" } },
    { bytes: invalidUtf8, headers: {} },
  ];
  for (const sample of samples) {
    const req = Object.assign(Readable.from([sample.bytes]), {
      url: "/admin/ai-providers",
      method: "POST",
      headers: {
        cookie: "session-fixture",
        origin: ORIGIN,
        "content-type": "application/json",
        ...sample.headers,
      },
    }) as unknown as IncomingMessage;
    const res = fakeResponse();
    await config.handle(req, res);
    assert.equal(res.code, 400);
    assert.deepEqual(JSON.parse(res.payload), { error: "invalid_request" });
    assert.ok(!res.payload.includes(EXAMPLE_KEY));
  }
  assert.equal(changes.length, 0);
});

test("valid bounded provider JSON with matching byte length still succeeds", async () => {
  const { store, changes } = createFixtureStore();
  const config = new AdminProviderConfiguration(auth, store, MASTER_KEY);
  const body = { action: "remove_key", provider: "openai" };
  const content = JSON.stringify(body);
  const response = fakeResponse();
  await config.handle(
    fakeRequest("POST", body, { "content-length": String(Buffer.byteLength(content)) }),
    response,
  );
  assert.equal(response.code, 200);
  assert.deepEqual(changes, [{ action: "remove_key", provider: "openai" }]);
});
