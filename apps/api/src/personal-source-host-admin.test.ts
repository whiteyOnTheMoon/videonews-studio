import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import type { NamedEditorialPgSession } from "./personal-editorial-admin.js";
import {
  DormantPersonalSourceHostAdmin,
  readPersonalSourceHostGates,
} from "./personal-source-host-admin.js";

const ID = "ca310001-1111-4111-8111-111111111111";
const ORIGIN = "https://studio.example.invalid";
const SOURCE = {
  id: "ci_solo_feed",
  baseUrl: "https://feed.example.org/news/",
  feedUrl: "https://feed.example.org/rss.xml",
  access: "rss",
  intervalMinutes: 60,
  termsUrl: "https://feed.example.org/terms/",
  usage: "metadata_only",
  licenseNotes: "Synthetic source is metadata-only, not a real license.",
};
const HOST = {
  action: "grant",
  expectedRevision: 0,
  expectedSourceRevision: 2,
  host: "feed.example.org",
  reason: "Sole owner separately reviewed the metadata-only host scope.",
};

function request(path: string, method = "GET", body?: unknown, origin = ORIGIN) {
  return Object.assign(Readable.from([body === undefined ? "" : JSON.stringify(body)]), {
    url: path,
    method,
    headers: {
      "content-type": "application/json",
      origin,
      cookie: "__Host-vns_editor=ci-valid",
    },
  }) as unknown as IncomingMessage;
}
function response() {
  const state = {
    code: 0,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(value: number) {
      this.code = value;
    },
    end(value: string) {
      this.body = value;
    },
  };
  return state as unknown as ServerResponse & typeof state;
}
function setup(
  opts: {
    source?: boolean;
    host?: boolean;
    identity?: "ok" | "missing" | "thrown";
    dbMismatch?: boolean;
    dbDown?: boolean;
    clock?: () => Date;
  } = {},
) {
  let sources: unknown[] = [];
  let sourceRevision = 0;
  let approvedHosts: unknown[] = [];
  let hostRevision = 0;
  let opened = 0;
  let closed = 0;
  const calls: string[] = [];
  const session = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push(sql);
      if (opts.dbDown) throw new Error("private secret must not be reflected");
      if (sql.includes("named_current_editor")) {
        return {
          rows: [
            {
              editor_id: opts.dbMismatch ? "ca310009-1111-4111-8111-111111111111" : ID,
              auth_version: 0,
              editor_role: "admin",
            },
          ],
        };
      }
      if (sql.includes("named_source_read"))
        return { rows: [{ revision: String(sourceRevision), sources: structuredClone(sources) }] };
      if (sql.includes("named_host_read"))
        return {
          rows: [
            {
              revision: String(hostRevision),
              approved_hosts: structuredClone(approvedHosts),
            },
          ],
        };
      if (sql.includes("named_source_commit")) {
        if (params[0] !== sourceRevision) return { rows: [{ saved: false }] };
        sourceRevision++;
        sources = JSON.parse(params[2] as string) as unknown[];
        return { rows: [{ saved: true }] };
      }
      if (sql.includes("named_host_change")) {
        if (params[0] !== hostRevision) return { rows: [{ saved: false }] };
        hostRevision++;
        if (params[2] === "grant") approvedHosts.push(params[3] as string);
        else approvedHosts = approvedHosts.filter((host) => host !== params[3]);
        return { rows: [{ saved: true }] };
      }
      throw new Error("Unapproved SQL");
    },
    async close() {
      closed++;
    },
  } as NamedEditorialPgSession;
  const gateway = new DormantPersonalSourceHostAdmin(
    {
      async authenticatedAdminIdentity() {
        if (opts.identity === "thrown") throw new Error("Auth service unavailable");
        if (opts.identity === "missing") return null;
        return { id: ID, username: "ci_admin", role: "admin" as const, authVersion: 0 };
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
        return session;
      },
    },
    opts.source ?? true,
    opts.host ?? true,
    opts.clock,
  );
  return {
    gateway,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    get calls() {
      return calls;
    },
    get sourceRevision() {
      return sourceRevision;
    },
  };
}
async function serve(
  gateway: DormantPersonalSourceHostAdmin,
  path: string,
  method = "GET",
  body?: unknown,
  origin = ORIGIN,
) {
  const output = response();
  assert.equal(await gateway.handle(request(path, method, body, origin), output), true);
  return {
    status: output.code,
    data: JSON.parse(output.body) as Record<string, unknown>,
    headers: output.headers,
  };
}

test("no flags, missing ACK, or shared-editor admission cannot enable source API", () => {
  assert.deepEqual(readPersonalSourceHostGates({}, false), {
    sourceEnabled: false,
    hostEnabled: false,
  });
  for (const flags of [
    { VNS_P2_SOURCE_ADMIN_ENABLED: "true" },
    { VNS_P2_SOURCE_ADMIN_OPERATOR_ACK: "true" },
    { VNS_P2_SOURCE_ADMIN_ENABLED: "enabled" },
    { VNS_P2_HOST_ADMIN_ENABLED: "true" },
    { VNS_P2_HOST_ADMIN_OPERATOR_ACK: "true" },
    { VNS_P2_HOST_ADMIN_ENABLED: "true", VNS_P2_HOST_ADMIN_OPERATOR_ACK: "true" },
  ]) {
    assert.throws(() => readPersonalSourceHostGates(flags, true));
  }
  assert.throws(() =>
    readPersonalSourceHostGates(
      {
        VNS_P2_SOURCE_ADMIN_ENABLED: "true",
        VNS_P2_SOURCE_ADMIN_OPERATOR_ACK: "true",
      },
      false,
    ),
  );
  assert.deepEqual(
    readPersonalSourceHostGates(
      {
        VNS_P2_SOURCE_ADMIN_ENABLED: "true",
        VNS_P2_SOURCE_ADMIN_OPERATOR_ACK: "true",
        VNS_P2_HOST_ADMIN_ENABLED: "true",
        VNS_P2_HOST_ADMIN_OPERATOR_ACK: "true",
      },
      true,
    ),
    { sourceEnabled: true, hostEnabled: true },
  );
  assert.throws(
    () =>
      new DormantPersonalSourceHostAdmin(
        { authenticatedAdminIdentity: async () => null },
        { originAllowed: () => true },
        {
          open: async () => {
            throw new Error("Never");
          },
        },
        false,
        true,
      ),
  );
});

test("default-off and separate flags deny before creating personal sessions", async () => {
  const state = setup({ source: false, host: false });
  assert.equal((await serve(state.gateway, "/admin/news-sources")).status, 404);
  assert.equal((await serve(state.gateway, "/admin/source-hosts")).status, 404);
  assert.equal(state.opened, 0);

  const sourceOnly = setup({ source: true, host: false });
  assert.equal((await serve(sourceOnly.gateway, "/admin/source-hosts")).status, 404);
  assert.equal(sourceOnly.opened, 0);
});

test("unauthenticated, mismatched DB principal and origin spoofing fail closed", async () => {
  const missing = setup({ identity: "missing" });
  assert.equal((await serve(missing.gateway, "/admin/news-sources")).status, 401);
  assert.equal(missing.opened, 0);

  const error = setup({ identity: "thrown" });
  assert.equal((await serve(error.gateway, "/admin/news-sources")).status, 503);
  assert.equal(error.opened, 0);

  const mismatch = setup({ dbMismatch: true });
  assert.equal((await serve(mismatch.gateway, "/admin/news-sources")).status, 403);
  assert.equal(mismatch.opened, 1);
  assert.equal(mismatch.closed, 1);
  assert.deepEqual(mismatch.calls, ["SELECT * FROM vns.named_current_editor()"]);

  const origin = setup();
  assert.equal(
    (
      await serve(
        origin.gateway,
        "/admin/source-hosts",
        "POST",
        HOST,
        "https://attacker.example.org",
      )
    ).status,
    403,
  );
  assert.equal(origin.opened, 0);
});

test("personally checked source/host GET, POST and CAS run on bounded SQL", async () => {
  const state = setup();
  assert.deepEqual((await serve(state.gateway, "/admin/news-sources")).data, {
    revision: 0,
    sources: [],
  });
  const created = await serve(state.gateway, "/admin/news-sources", "POST", {
    action: "create_pending",
    expectedRevision: 0,
    source: SOURCE,
  });
  assert.deepEqual(created.data, {
    saved: true,
    revision: 1,
    sourceId: SOURCE.id,
    status: "pending",
    feedActive: false,
  });
  assert.equal(created.headers["cache-control"], "no-store");
  assert.equal(
    (
      await serve(state.gateway, "/admin/news-sources", "POST", {
        action: "create_pending",
        expectedRevision: 0,
        source: SOURCE,
      })
    ).status,
    409,
  );
  const approval = await serve(state.gateway, "/admin/news-sources", "POST", {
    action: "approve",
    expectedRevision: 1,
    sourceId: SOURCE.id,
  });
  assert.deepEqual(approval.data, {
    saved: true,
    revision: 2,
    sourceId: SOURCE.id,
    status: "approved",
    feedActive: false,
  });

  assert.deepEqual((await serve(state.gateway, "/admin/source-hosts")).data, {
    revision: 0,
    approvedHosts: [],
    feedActive: false,
  });
  assert.deepEqual((await serve(state.gateway, "/admin/source-hosts", "POST", HOST)).data, {
    saved: true,
    host: HOST.host,
    action: "grant",
    revision: 1,
    feedActive: false,
  });
  assert.deepEqual((await serve(state.gateway, "/admin/source-hosts")).data, {
    revision: 1,
    approvedHosts: ["feed.example.org"],
    feedActive: false,
  });
  assert.equal((await serve(state.gateway, "/admin/source-hosts", "POST", HOST)).status, 409);
  assert.equal(state.opened, state.closed);
  assert.equal(
    state.calls.every((sql) => sql.startsWith("SELECT ")),
    true,
  );
  assert.equal(
    state.calls.some((sql) => sql.includes("admin_commit_source_registry")),
    false,
  );
  assert.equal(
    state.calls.some((sql) => sql.includes("admin_change_source_host_approval")),
    false,
  );
});

test("forged actor fields, bad framing and unsafe host are rejected before DB", async () => {
  const state = setup();
  for (const payload of [
    { action: "approve", expectedRevision: 0, sourceId: SOURCE.id, actorId: ID },
    { action: "create_pending", expectedRevision: 0, source: { ...SOURCE, status: "approved" } },
    { ...HOST, editorId: ID },
    { ...HOST, host: "127.0.0.1" },
  ]) {
    const path = "host" in payload ? "/admin/source-hosts" : "/admin/news-sources";
    assert.equal((await serve(state.gateway, path, "POST", payload)).status, 400);
  }
  assert.equal((await serve(state.gateway, "/admin/news-sources?debug=1")).status, 404);
  assert.equal((await serve(state.gateway, "/admin/source-hosts", "DELETE")).status, 405);
  assert.equal(state.opened, 0);
});

test("personal DB errors are redacted; sessions always close; 10-write ceiling", async () => {
  const fail = setup({ dbDown: true });
  const response = await serve(fail.gateway, "/admin/news-sources");
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response.data).includes("private secret"), false);
  assert.equal(fail.closed, 1);

  const state = setup();
  for (let i = 0; i < 10; i++) {
    const outcome = await serve(state.gateway, "/admin/news-sources", "POST", {
      action: "approve",
      expectedRevision: 0,
      sourceId: "absent_source",
    });
    assert.equal(outcome.status, 409);
  }
  assert.equal((await serve(state.gateway, "/admin/source-hosts", "POST", HOST)).status, 429);
  assert.equal(state.opened, state.closed);
});
