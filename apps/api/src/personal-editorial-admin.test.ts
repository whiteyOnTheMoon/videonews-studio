import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  DormantPersonalEditorialAdmin,
  validateNamedEditorialProfiles,
  type NamedEditorialPgSession,
} from "./personal-editorial-admin.js";

const ACTOR = "ca310001-1111-4111-8111-111111111111";
const ORIGIN = "https://studio.example.invalid";
const profile = {
  id: "science_news",
  language: "de-DE",
  keywords: ["science"],
  blockedTerms: [],
  minIndependentSources: 2,
  maximumArticleAgeHours: 24,
  format: "briefing",
};
function request(url: string, method = "GET", body?: unknown, origin = ORIGIN) {
  return Object.assign(Readable.from([body === undefined ? "" : JSON.stringify(body)]), {
    url,
    method,
    headers: {
      origin,
      "content-type": "application/json",
      cookie: "__Host-vns_editor=ci-personal-session",
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
    end(data: string) {
      this.body = data;
    },
  };
  return fake as unknown as ServerResponse & typeof fake;
}
function setup(mismatch = false, enabled = true) {
  let opened = 0;
  let closed = 0;
  const sql: string[] = [];
  const client = {
    async query(sqlText: string) {
      sql.push(sqlText);
      if (sqlText.includes("named_current_editor")) {
        return {
          rows: [{
            editor_id: mismatch ? "ca310099-9999-4999-8999-999999999999" : ACTOR,
            auth_version: 0,
            editor_role: "admin",
          }],
        };
      }
      if (sqlText.includes("named_profile_read")) {
        return { rows: [{ revision: "0", profiles: [] }] };
      }
      if (sqlText.includes("named_profile_commit")) {
        return { rows: [{ saved: true }] };
      }
      return { rows: [] };
    },
    async close() {
      closed++;
    },
  } as unknown as NamedEditorialPgSession;
  const handler = new DormantPersonalEditorialAdmin(
    {
      async authenticatedAdminIdentity() {
        return { id: ACTOR, authVersion: 0, username: "ci_admin", role: "admin" as const };
      },
    },
    {
      originAllowed(req) {
        return req.headers.origin === ORIGIN;
      },
    },
    {
      async open() {
        opened++;
        return client;
      },
    },
    enabled,
  );
  return {
    handler,
    sql,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
  };
}
async function serve(
  instance: DormantPersonalEditorialAdmin,
  url: string,
  method = "GET",
  body?: unknown,
  origin = ORIGIN,
) {
  const result = response();
  assert.equal(await instance.handle(request(url, method, body, origin), result), true);
  return {
    status: result.code,
    json: JSON.parse(result.body) as Record<string, unknown>,
    headers: result.headers,
  };
}

test("strict profile settings reject injected keys, bogus budgets and duplicate IDs", () => {
  assert.deepEqual(validateNamedEditorialProfiles([profile]), [profile]);
  for (const bad of [
    [{ ...profile, apiKey: "forbidden" }],
    [{ ...profile, maximumArticleAgeHours: 0 }],
    [{ ...profile, keywords: ["s"] }],
    [{ ...profile, language: "javascript:evil" }],
    [profile, profile],
  ]) {
    assert.equal(validateNamedEditorialProfiles(bad), null);
  }
});

test("disabled handler cannot open a personal DB connection", async () => {
  const state = setup(false, false);
  assert.equal((await serve(state.handler, "/admin/editorial-profiles")).status, 404);
  assert.equal(state.opened, 0);
});

test("Admin read/write requires personal DB attestation and audit revision", async () => {
  const state = setup();
  const read = await serve(state.handler, "/admin/editorial-profiles");
  assert.equal(read.status, 200);
  assert.deepEqual(read.json, { revision: 0, profiles: [] });
  assert.equal(read.headers["cache-control"], "no-store");
  const saved = await serve(
    state.handler,
    "/admin/editorial-profiles",
    "POST",
    { expectedRevision: 0, profiles: [profile] },
  );
  assert.deepEqual(saved.json, {
    saved: true,
    revision: 1,
    productionActive: false,
  });
  assert.equal(state.opened, 2);
  assert.equal(state.closed, 2);
  assert.ok(state.sql.every((sql) => !sql.includes("ci_admin")));
});

test("mismatched DB principal, invalid payload and forged origin are blocked", async () => {
  const mismatch = setup(true);
  assert.equal((await serve(mismatch.handler, "/admin/editorial-profiles")).status, 403);
  assert.equal(mismatch.closed, 1);
  assert.equal(mismatch.sql.length, 1);
  const state = setup();
  assert.equal(
    (await serve(state.handler, "/admin/editorial-profiles", "POST",
      { expectedRevision: 0, profiles: [{ ...profile, apiKey: "x" }] })).status,
    400,
  );
  assert.equal(
    (await serve(state.handler, "/admin/editorial-profiles", "POST",
      { expectedRevision: 0, profiles: [profile] }, "https://invalid.example")).status,
    403,
  );
  assert.equal(state.opened, 0);
});

test("bounded timeline and checkpoint cursor exports require exact IDs", async () => {
  const state = setup();
  const story = "ca310002-2222-4222-8222-222222222222";
  assert.equal(
    (await serve(state.handler,
      "/admin/editorial-timeline?storyId=" + story + "&limit=10")).status,
    200,
  );
  assert.equal(
    (await serve(state.handler,
      "/admin/editorial-checkpoints?eventId=" + story + "&after=0&limit=10")).status,
    200,
  );
  assert.equal(
    (await serve(state.handler,
      "/admin/editorial-checkpoints?eventId=bad&after=0&limit=10")).status,
    400,
  );
  assert.equal(state.opened, 3);
  assert.equal(state.closed, 3);
});
