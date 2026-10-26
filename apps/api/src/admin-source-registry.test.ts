import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  DormantNamedSourceAdmin,
  applySourceAdminCommand,
  parseSourceAdminCommand,
  validateSourceDraft,
  validateSourceSnapshot,
  type SourceAdminStore,
  type SourceAuditEvent,
  type SourceSnapshot,
} from "./admin-source-registry.js";

const ORIGIN = "https://studio.example.invalid";
const EDITOR_ID = "12345678-1234-4123-8123-123456789012";
const TODAY = new Date("2026-10-25T10:30:00.000Z");
const sample = {
  id: "city_news",
  baseUrl: "https://city.example.org/news/",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://city.example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "This synthetic source permits metadata citations only.",
};

function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  const serialized = body === undefined ? "" : JSON.stringify(body);
  return Object.assign(Readable.from([serialized]), {
    url: "/admin/news-sources",
    method,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie: "__Host-vns_editor=personal-fixture",
      ...headers,
    },
  }) as unknown as IncomingMessage;
}
function response() {
  const fake = {
    code: 0,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
    },
    writeHead(code: number) {
      this.code = code;
    },
    end(text: string) {
      this.body = text;
    },
  };
  return fake as unknown as ServerResponse & typeof fake;
}

function setup() {
  let state: SourceSnapshot = { revision: 0, sources: [] };
  const audits: SourceAuditEvent[] = [];
  let reads = 0;
  let admissionCalls = 0;
  let identityCalls = 0;
  let allowed = true;
  const store: SourceAdminStore = {
    async read() {
      reads++;
      return structuredClone(state);
    },
    async saveWithAudit(expectedRevision, next, audit) {
      if (expectedRevision !== state.revision) return "conflict";
      state = structuredClone(next);
      audits.push(audit);
      return "saved";
    },
  };
  const editor = {
    async authenticatedAdminIdentity(req: IncomingMessage) {
      identityCalls++;
      if (req.headers.cookie !== "__Host-vns_editor=personal-fixture") return null;
      return { id: EDITOR_ID, username: "ci_admin", role: "admin" as const, authVersion: 3 };
    },
  };
  const origin = { originAllowed: (req: IncomingMessage) => req.headers.origin === ORIGIN };
  const admission = {
    async allow() {
      admissionCalls++;
      return allowed;
    },
  };
  const handler = new DormantNamedSourceAdmin(editor, origin, store, admission, true, () => TODAY);
  return {
    handler,
    store,
    audits,
    get state() { return state; },
    get reads() { return reads; },
    get identityCalls() { return identityCalls; },
    get admissionCalls() { return admissionCalls; },
    denyRate() { allowed = false; },
  };
}
async function serve(
  handler: DormantNamedSourceAdmin,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const result = response();
  assert.equal(await handler.handle(request(method, body, headers), result), true);
  return { code: result.code, data: JSON.parse(result.body) as Record<string, unknown>, headers: result.headers };
}

test("no hardcoded publisher: strict operator-entered metadata and URL policy", () => {
  assert.deepEqual(validateSourceDraft(sample), sample);
  for (const invalid of [
    { ...sample, status: "approved" },
    { ...sample, apiKey: "secret" },
    { ...sample, intervalMinutes: 1 },
    { ...sample, intervalMinutes: 60.5 },
    { ...sample, licenseNotes: "short" },
    { ...sample, termsUrl: "http://city.example.org/terms/" },
    { ...sample, baseUrl: "https://localhost/feed/" },
    { ...sample, baseUrl: "https://127.0.0.1/feed/" },
    { ...sample, baseUrl: "https://city.example.org/feed/%2e%2e/" },
    { ...sample, baseUrl: "https://city.example.org/news/?key=private" },
    { ...sample, baseUrl: "https://evil@city.example.org/news/" },
    { ...sample, baseUrl: "https://city.example.org/news" },
    { ...sample, access: "any_external_script" },
  ]) {
    assert.equal(validateSourceDraft(invalid), null, JSON.stringify(invalid));
  }
});

test("commands exclude client role, review date, active flags and forged actors", () => {
  assert.deepEqual(parseSourceAdminCommand({
    action: "create_pending", expectedRevision: 0, source: sample,
  }), { action: "create_pending", expectedRevision: 0, source: sample });
  for (const bad of [
    { action: "create_pending", expectedRevision: 0, source: { ...sample, status: "approved" } },
    { action: "approve", expectedRevision: 1, sourceId: sample.id, role: "admin" },
    { action: "approve", expectedRevision: 1, sourceId: sample.id, reviewedAt: "2099-01-01" },
    { action: "approve", expectedRevision: -1, sourceId: sample.id },
    { action: "activate", expectedRevision: 0, sourceId: sample.id },
    { action: "delete", expectedRevision: 0, sourceId: sample.id },
    { action: "replace_pending", expectedRevision: 0, source: { ...sample, apiKey: "synthetic" } },
  ]) assert.equal(parseSourceAdminCommand(bad), null);
});

test("source changes always reset to pending; approvals only from explicit review", () => {
  const state = validateSourceSnapshot({ revision: 0, sources: [] });
  const create = parseSourceAdminCommand({
    action: "create_pending", expectedRevision: 0, source: sample,
  })!;
  const first = applySourceAdminCommand(state, create, "2026-10-25")!;
  assert.equal(first.status, "pending");
  assert.equal(first.next.sources[0]?.status, "pending");
  assert.equal(applySourceAdminCommand(first.next, create, "2026-10-25"), null);
  const approval = applySourceAdminCommand(first.next, {
    action: "approve", expectedRevision: 1, sourceId: sample.id,
  }, "2026-10-25")!;
  assert.equal(approval.next.sources[0]?.status, "approved");
  assert.equal(applySourceAdminCommand(approval.next, {
    action: "approve", expectedRevision: 2, sourceId: sample.id,
  }, "2026-10-25"), null);
  const revised = applySourceAdminCommand(approval.next, {
    action: "replace_pending", expectedRevision: 2,
    source: { ...sample, intervalMinutes: 120 },
  }, "2026-10-25")!;
  assert.equal(revised.next.sources[0]?.status, "pending");
  const blocked = applySourceAdminCommand(revised.next, {
    action: "block", expectedRevision: 3, sourceId: sample.id,
  }, "2026-10-25")!;
  assert.equal(blocked.next.sources[0]?.status, "blocked");
  const reopened = applySourceAdminCommand(blocked.next, {
    action: "reopen", expectedRevision: 4, sourceId: sample.id,
  }, "2026-10-25")!;
  assert.equal(reopened.next.sources[0]?.status, "pending");
});

test("snapshot rejects duplicate scopes, forged statuses and invalid revisions", () => {
  const pending = { ...sample, status: "pending", reviewedAt: "2026-10-25" };
  for (const invalid of [
    { revision: -1, sources: [] },
    { revision: 1, sources: [{ ...pending, status: "active" }] },
    { revision: 1, sources: [{ ...pending, reviewedAt: "2026-02-30" }] },
    { revision: 1, sources: [pending, pending] },
    { revision: 1, sources: [{ ...pending, apiKey: "synthetic" }] },
  ]) assert.throws(() => validateSourceSnapshot(invalid), /unavailable/);
});

test("personal admin can create, approve, block and list sources with audited revision", async () => {
  const f = setup();
  const command = { action: "create_pending", expectedRevision: 0, source: sample };
  assert.deepEqual((await serve(f.handler, "GET")).data, { revision: 0, sources: [] });
  const created = await serve(f.handler, "POST", command);
  assert.deepEqual(created.data, {
    saved: true, revision: 1, sourceId: sample.id, status: "pending", feedActive: false,
  });
  assert.equal(created.headers["cache-control"], "no-store");
  assert.equal(f.audits.length, 1);
  assert.deepEqual(f.audits[0], {
    actorId: EDITOR_ID,
    actorUsername: "ci_admin",
    actorAuthVersion: 3,
    sourceId: sample.id,
    action: "create_pending",
    revision: 1,
    recordedAt: TODAY.toISOString(),
  });
  const conflict = await serve(f.handler, "POST", command);
  assert.equal(conflict.code, 409);
  assert.equal(f.audits.length, 1);
  assert.equal((await serve(f.handler, "POST", {
    action: "approve", expectedRevision: 1, sourceId: sample.id,
  })).code, 200);
  assert.equal(f.state.sources[0]?.status, "approved");
  assert.equal((await serve(f.handler, "POST", {
    action: "block", expectedRevision: 2, sourceId: sample.id,
  })).code, 200);
  assert.equal(f.state.sources[0]?.status, "blocked");
  assert.equal(f.audits.length, 3);
});

test("disabled endpoint, wrong editor cookie, forbidden origin and rate gate block writes", async () => {
  const f = setup();
  const command = { action: "create_pending", expectedRevision: 0, source: sample };
  const disabled = new DormantNamedSourceAdmin(
    { authenticatedAdminIdentity: async () => { throw new Error("must not query"); } },
    { originAllowed: () => true },
    f.store,
    { allow: async () => true },
  );
  assert.equal((await serve(disabled, "POST", command)).code, 404);
  assert.equal((await serve(f.handler, "POST", command, {
    cookie: "__Host-vns_session=shared-admin",
  })).code, 401);
  assert.equal((await serve(f.handler, "POST", command, {
    origin: "https://other.example.org",
  })).code, 403);
  f.denyRate();
  assert.equal((await serve(f.handler, "POST", command)).code, 429);
  assert.equal(f.reads, 0);
  assert.equal(f.audits.length, 0);
});

test("bad framing, unknown fields and malicious encoding cannot reach storage", async () => {
  const f = setup();
  const command = { action: "create_pending", expectedRevision: 0, source: sample };
  for (const headers of [
    { "content-type": "text/plain" },
    { "content-encoding": "gzip" },
    { "content-length": "1" },
    { "content-length": "0001" },
    { "content-length": "4097" },
  ]) assert.equal((await serve(f.handler, "POST", command, headers)).code, 400);
  assert.equal((await serve(f.handler, "POST", { ...command, editorId: EDITOR_ID })).code, 400);
  assert.equal(f.audits.length, 0);
  assert.equal(f.reads, 0);
});

test("store failures and CAS races never expose implementation details", async () => {
  const f = setup();
  const failed = new DormantNamedSourceAdmin(
    { authenticatedAdminIdentity: async () => ({
      id: EDITOR_ID, username: "ci_admin", role: "admin", authVersion: 3,
    }) },
    { originAllowed: () => true },
    {
      async read() { return { revision: 0, sources: [] }; },
      async saveWithAudit() { throw new Error("private DB details"); },
    },
    { allow: async () => true },
    true,
    () => TODAY,
  );
  const req = { action: "create_pending", expectedRevision: 0, source: sample };
  const result = await serve(failed, "POST", req);
  assert.equal(result.code, 503);
  assert.equal(JSON.stringify(result.data).includes("private"), false);
  assert.equal(f.audits.length, 0);
});
