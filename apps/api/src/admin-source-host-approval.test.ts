import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import {
  DormantNamedHostApproval,
  parseHostApprovalCommand,
  validateHostApprovalSnapshot,
  type HostApprovalStore,
} from "./admin-source-host-approval.js";
import { PostgresHostApprovalStore } from "./source-host-postgres.js";
import type { SourceQueryPort } from "./source-admin-postgres.js";

const admin = {
  id: "12345678-1234-4123-8123-123456789012",
  username: "ci_admin",
  role: "admin" as const,
  authVersion: 2,
};
const command = {
  action: "grant" as const,
  expectedRevision: 0,
  expectedSourceRevision: 2,
  host: "news.example.org",
  reason: "Reviewed synthetic publisher usage terms for metadata only.",
};
function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return Object.assign(Readable.from([body === undefined ? "" : JSON.stringify(body)]), {
    url: "/admin/source-hosts",
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://studio.example.org",
      cookie: "__Host-vns_editor=synthetic",
      ...headers,
    },
  }) as unknown as IncomingMessage;
}
function response() {
  const state = {
    code: 0,
    body: "",
    setHeader: () => undefined,
    writeHead(code: number) {
      this.code = code;
    },
    end(value: string) {
      this.body = value;
    },
  };
  return state as unknown as ServerResponse & typeof state;
}
function fixture() {
  const current = { revision: 0, approvedHosts: [] as string[] };
  const events: Array<{ actor: string; host: string; action: string }> = [];
  let operations = 0;
  let rateAllowed = true;
  const store: HostApprovalStore = {
    async read() {
      return structuredClone(current);
    },
    async commit(change, identity) {
      operations++;
      if (change.expectedRevision !== current.revision) return "conflict";
      if (change.action === "grant") current.approvedHosts.push(change.host);
      else current.approvedHosts = current.approvedHosts.filter((host) => host !== change.host);
      current.revision++;
      events.push({ actor: identity.id, host: change.host, action: change.action });
      return "saved";
    },
  };
  const handler = new DormantNamedHostApproval(
    {
      async authenticatedAdminIdentity(req) {
        return req.headers.cookie === "__Host-vns_editor=synthetic" ? admin : null;
      },
    },
    { originAllowed: (req) => req.headers.origin === "https://studio.example.org" },
    store,
    { allow: async () => rateAllowed },
    true,
  );
  async function serve(method: string, body?: unknown, headers?: Record<string, string>) {
    const res = response();
    assert.equal(await handler.handle(request(method, body, headers), res), true);
    return { status: res.code, data: JSON.parse(res.body) as Record<string, unknown> };
  }
  return {
    serve,
    events,
    setRateAllowed(value: boolean) {
      rateAllowed = value;
    },
    get operations() {
      return operations;
    },
  };
}
test("strict host and reason commands reject forged identities and untrusted extras", () => {
  assert.deepEqual(parseHostApprovalCommand(command), command);
  for (const invalid of [
    { ...command, editorId: admin.id },
    { ...command, approvedHosts: ["other.example.org"] },
    { ...command, host: "127.0.0.1" },
    { ...command, host: "localhost" },
    { ...command, host: "xn--fake.example.org" },
    { ...command, host: "news.example.org:443" },
    { ...command, expectedRevision: -1 },
    { ...command, expectedSourceRevision: 0 },
    { ...command, reason: "too short" },
    { ...command, action: "activate" },
  ])
    assert.equal(parseHostApprovalCommand(invalid), null);
  assert.deepEqual(validateHostApprovalSnapshot({ revision: 0, approvedHosts: [] }), {
    revision: 0,
    approvedHosts: [],
  });
  assert.throws(() =>
    validateHostApprovalSnapshot({ revision: 1, approvedHosts: ["news.example.org"], apiKey: "x" }),
  );
  assert.throws(() =>
    validateHostApprovalSnapshot({
      revision: 1,
      approvedHosts: ["news.example.org", "news.example.org"],
    }),
  );
});
test("personal named admin can grant and revoke, but no feed becomes active", async () => {
  const f = fixture();
  const initial = await f.serve("GET");
  assert.deepEqual(initial.data, { revision: 0, approvedHosts: [], feedActive: false });
  const granted = await f.serve("POST", command);
  assert.deepEqual(granted.data, {
    saved: true,
    host: command.host,
    action: "grant",
    revision: 1,
    feedActive: false,
  });
  assert.equal(f.events[0]?.actor, admin.id);
  assert.equal((await f.serve("POST", command)).status, 409);
  assert.equal(
    (
      await f.serve("POST", {
        ...command,
        action: "revoke",
        expectedRevision: 1,
      })
    ).status,
    200,
  );
  assert.equal(f.events.length, 2);
});
test("disabled, wrong session, foreign origin, throttled or malformed request never mutates", async () => {
  const f = fixture();
  assert.equal(
    (await f.serve("POST", command, { cookie: "__Host-vns_session=shared" })).status,
    401,
  );
  assert.equal(
    (await f.serve("POST", command, { origin: "https://evil.example.org" })).status,
    403,
  );
  f.setRateAllowed(false);
  assert.equal((await f.serve("POST", command)).status, 429);
  f.setRateAllowed(true);
  assert.equal((await f.serve("POST", { ...command, extra: true })).status, 400);
  assert.equal((await f.serve("POST", command, { "content-type": "text/plain" })).status, 400);
  assert.equal(f.operations, 0);
  const disabled = new DormantNamedHostApproval(
    {
      authenticatedAdminIdentity: async () => {
        throw new Error("do not read");
      },
    },
    { originAllowed: () => true },
    {
      read: async () => {
        throw new Error("do not read");
      },
      commit: async () => "saved",
    },
    { allow: async () => true },
  );
  const res = response();
  assert.equal(await disabled.handle(request("POST", command), res), true);
  assert.equal(res.code, 404);
});
test("detached SQL adapter uses positional parameters and denies invalid actor locally", async () => {
  const calls: unknown[][] = [];
  const port: SourceQueryPort = {
    async query(sql, args) {
      calls.push([sql, ...(args ?? [])]);
      if (sql.startsWith("SELECT revision")) {
        return { rows: [{ revision: "0", approvedHosts: [] }] };
      }
      return { rows: [{ saved: true }] };
    },
  };
  const adapter = new PostgresHostApprovalStore(port);
  assert.deepEqual(await adapter.read(), { revision: 0, approvedHosts: [] });
  assert.equal(await adapter.commit(command, admin), "saved");
  assert.match(String(calls[1]?.[0]), /admin_change_source_host_approval/);
  assert.deepEqual(calls[1]?.slice(1), [
    0,
    2,
    "grant",
    command.host,
    command.reason,
    admin.id,
    admin.authVersion,
  ]);
  await assert.rejects(adapter.commit(command, { ...admin, role: "editor" }));
  await assert.rejects(adapter.commit({ ...command, host: "localhost" }, admin));
  assert.equal(calls.length, 2);
});
