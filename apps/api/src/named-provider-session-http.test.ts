import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Pool } from "pg";
import { AdminAuth } from "./auth.js";
import { AdminEvidence } from "./admin-evidence.js";
import { AdminJobs } from "./admin-jobs.js";
import { EditorAuth, type EditorAccount, type EditorStore } from "./editor-auth.js";
import { NamedAdminProviderConfiguration } from "./named-admin-provider-configuration.js";
import { PostgresNamedProviderConfigStore } from "./postgres-named-provider-config-store.js";
import { PostgresProviderMutationLimiter } from "./postgres-provider-mutation-limiter.js";
import { createApiServer } from "./server.js";

const ORIGIN = "https://studio.example.invalid";
const EDITOR_ID = "11111111-2222-4333-8444-555555555555";
const PASSWORD = "ci-named-editor-admin-password";
const SHARED_PASSWORD = "ci-shared-admin-password";
const SYNTHETIC_KEY = "sk-ci-not-a-real-credential-1234567890123";

function hash(password: string, salt: string): string {
  return "scrypt$" + salt + "$" + scryptSync(
    password,
    Buffer.from(salt, "hex"),
    64,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
  ).toString("hex");
}

test("real editor session drives named provider HTTP to sealed and audited SQL", async () => {
  const account: EditorAccount = {
    id: EDITOR_ID,
    username: "ci_admin",
    role: "admin",
    active: true,
    authVersion: 0,
    passwordHash: hash(PASSWORD, "a".repeat(32)),
  };
  const editorStore: EditorStore = {
    async findAccount(username) {
      return username === account.username ? account : null;
    },
    async activeIdentity(id) {
      return id === account.id && account.active
        ? {
            id: account.id,
            username: account.username,
            role: account.role,
            authVersion: account.authVersion,
          }
        : null;
    },
    async review() {
      return "forbidden";
    },
  };
  const editor = new EditorAuth(editorStore, ORIGIN);
  const auth = new AdminAuth({
    origin: ORIGIN,
    passwordHash: hash(SHARED_PASSWORD, "b".repeat(32)),
  });
  const jobs = new AdminJobs(
    auth,
    {
      async createResearchJob() {
        return EDITOR_ID;
      },
      async listRecentResearchJobs() {
        return [];
      },
    },
    new AdminEvidence(
      auth,
      { list: async () => [], review: async () => "updated" },
      false,
    ),
  );
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let admissions = 0;
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("admin_try_ai_provider_mutation_slot")) {
        admissions++;
        return { rows: [{ allowed: admissions <= 2 }] };
      }
      if (sql.includes("admin_mutate_ai_provider_as_editor")) {
        return { rows: [] };
      }
      if (sql.includes("admin_list_ai_providers")) {
        return {
          rows: [
            { provider: "openai", selectedModel: "gpt-6.1-sol", configured: false },
            {
              provider: "google_gemini",
              selectedModel: "gemini-3.8-flash-tts",
              configured: false,
            },
          ],
        };
      }
      throw new Error("Unexpected SQL in synthetic named-provider test");
    },
  } as unknown as Pool;
  const key = randomBytes(32);
  const provider = new NamedAdminProviderConfiguration(
    editor,
    auth,
    new PostgresNamedProviderConfigStore(pool),
    key,
    new PostgresProviderMutationLimiter(pool),
  );
  const server = createApiServer({ auth, jobs, editor, providerConfig: provider });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (cookie: string, body: object, origin = ORIGIN) =>
    fetch(base + "/admin/ai-providers", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(base + "/admin/ai-providers")).status, 401);

    const sharedLogin = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ password: SHARED_PASSWORD }),
    });
    assert.equal(sharedLogin.status, 200);
    const sharedCookie = (sharedLogin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.equal(
      (await fetch(base + "/admin/ai-providers", { headers: { Cookie: sharedCookie } })).status,
      401,
    );

    const personalLogin = await fetch(base + "/editor/auth/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ username: account.username, password: PASSWORD }),
    });
    assert.equal(personalLogin.status, 200);
    const personalCookie = (personalLogin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const authorized = await fetch(base + "/admin/ai-providers", {
      headers: { Cookie: personalCookie },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), {
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

    assert.equal(
      (await post(personalCookie, { action: "remove_key", provider: "openai" }, "https://forged.invalid"))
        .status,
      403,
    );
    assert.equal(
      (await post(personalCookie, {
        action: "remove_key",
        provider: "openai",
        editorId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      })).status,
      400,
    );
    assert.equal((await post(personalCookie, {
      action: "set_key",
      provider: "openai",
      apiKey: SYNTHETIC_KEY,
    })).status, 200);

    const writes = calls.filter((call) => call.sql.includes("admin_mutate_ai_provider_as_editor"));
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.params[6], EDITOR_ID);
    assert.equal(writes[0]?.params[7], 0);
    assert.ok(Buffer.isBuffer(writes[0]?.params[4]));
    assert.ok(!JSON.stringify(writes).includes(SYNTHETIC_KEY));
    assert.equal(
      (await post(personalCookie, { action: "remove_key", provider: "openai" })).status,
      429,
    );
    account.authVersion++;
    assert.equal(
      (await post(personalCookie, { action: "remove_key", provider: "openai" })).status,
      401,
    );
    assert.equal(calls.filter((call) => call.sql.includes("admin_mutate_ai_provider_as_editor")).length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await editor.close();
    key.fill(0);
  }
});

test("named provider dispatch cannot mount without editor authentication", () => {
  const key = randomBytes(32);
  try {
    const provider = new NamedAdminProviderConfiguration(
      { authenticatedAdminIdentity: async () => null },
      { originAllowed: () => true },
      {
        list: async () => [],
        mutateAsNamedAdmin: async () => undefined,
      },
      key,
      { allow: async () => true },
    );
    assert.throws(
      () => createApiServer({ auth: {} as AdminAuth, providerConfig: provider }),
      /requires personal editor authentication/,
    );
    assert.throws(
      () => new NamedAdminProviderConfiguration(
        { authenticatedAdminIdentity: async () => null },
        { originAllowed: () => true },
        { list: async () => [], mutateAsNamedAdmin: async () => undefined },
        key,
        undefined as unknown as { allow(): Promise<boolean> },
      ),
      /rate admission is required/,
    );
  } finally {
    key.fill(0);
  }
});

test("named admission database outages reject before consuming a credential body", async () => {
  let reads = 0;
  let writes = 0;
  const key = randomBytes(32);
  try {
    const provider = new NamedAdminProviderConfiguration(
      { authenticatedAdminIdentity: async () => ({
        id: EDITOR_ID,
        username: "ci_admin",
        role: "admin",
        authVersion: 0,
      }) },
      { originAllowed: () => true },
      {
        list: async () => [],
        mutateAsNamedAdmin: async () => { writes++; },
      },
      key,
      { allow: async () => { throw new Error("private-db-host-secret"); } },
    );
    const source = (async function* () {
      reads++;
      yield JSON.stringify({ action: "set_key", provider: "openai", apiKey: SYNTHETIC_KEY });
    })();
    const request = Object.assign(
      (await import("node:stream")).Readable.from(source),
      {
        method: "POST",
        url: "/admin/ai-providers",
        headers: { origin: ORIGIN, "content-type": "application/json" },
      },
    ) as IncomingMessage;
    const result = {
      status: 0,
      body: "",
      headers: {} as Record<string, string>,
      setHeader(name: string, value: string) { this.headers[name] = value; },
      writeHead(code: number) { this.status = code; },
      end(data: string) { this.body = data; },
    };
    await provider.handle(request, result as unknown as import("node:http").ServerResponse);
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(result.body), { error: "temporarily_unavailable" });
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.ok(!result.body.includes(SYNTHETIC_KEY));
  } finally {
    key.fill(0);
  }
});
