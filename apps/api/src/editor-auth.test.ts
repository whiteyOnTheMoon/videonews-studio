import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AdminAuth } from "./auth.js";
import { AdminJobs } from "./admin-jobs.js";
import { AdminEvidence, type EvidenceReviewStore } from "./admin-evidence.js";
import { createApiServer } from "./server.js";
import {
  EditorAuth,
  editorAuthFromEnv,
  type EditorStore,
  type EditorAccount,
} from "./editor-auth.js";

const ORIGIN = "https://studio.example.invalid";
const ID = "12345678-1234-4123-8123-123456789012";
const EVIDENCE = "87654321-4321-4432-8432-210987654321";
const PASSWORD = "editor-test-only-password";
const REASON = "A careful comparison with the source supports only part of the claim.";
const HASH = `scrypt$${"a".repeat(32)}$${scryptSync(
  PASSWORD,
  Buffer.from("a".repeat(32), "hex"),
  64,
  {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  },
).toString("hex")}`;
const ADMIN_PASS = "separate-shared-admin-password";
const ADMIN_HASH = `scrypt$${"b".repeat(32)}$${scryptSync(
  ADMIN_PASS,
  Buffer.from("b".repeat(32), "hex"),
  64,
  {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  },
).toString("hex")}`;

async function serverFixture(
  fn: (
    base: string,
    auth: EditorAuth,
    state: { account: EditorAccount; reviews: number },
  ) => Promise<void>,
) {
  const state = {
    account: {
      id: ID,
      username: "test_editor",
      role: "reviewer" as const,
      active: true,
      passwordHash: HASH,
      authVersion: 0,
    },
    reviews: 0,
  };
  const store: EditorStore = {
    async findAccount(name) {
      return name === state.account.username ? state.account : null;
    },
    async activeIdentity(id) {
      return id === state.account.id && state.account.active
        ? {
            id: state.account.id,
            username: state.account.username,
            role: state.account.role,
            authVersion: state.account.authVersion,
          }
        : null;
    },
    async review(id, verdict, reason, editorId, authVersion) {
      assert.equal(authVersion, state.account.authVersion);
      assert.equal(id, EVIDENCE);
      assert.equal(editorId, ID);
      assert.equal(reason, REASON);
      assert.equal(verdict, "disputed");
      state.reviews += 1;
      return "updated";
    },
  };
  const auth = new AdminAuth({ passwordHash: ADMIN_HASH, origin: ORIGIN });
  const evidence: EvidenceReviewStore = {
    async list() {
      return [];
    },
    async review() {
      return "updated";
    },
  };
  const jobs = new AdminJobs(
    auth,
    {
      async createResearchJob() {
        return ID;
      },
      async listRecentResearchJobs() {
        return [];
      },
    },
    new AdminEvidence(auth, evidence, false),
  );
  const editor = new EditorAuth(store, ORIGIN);
  const server = createApiServer({ auth, jobs, editor });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, editor, state);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await editor.close();
  }
}
function login(base: string, username = "test_editor", password = PASSWORD, origin = ORIGIN) {
  return fetch(base + "/editor/auth/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}
function review(base: string, cookie: string, origin = ORIGIN) {
  return fetch(base + "/editor/evidence/review", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ evidenceId: EVIDENCE, decision: "disputed", reason: REASON }),
  });
}

test("editor auth is opt-in and refuses unauthorized deployment configuration", () => {
  assert.equal(editorAuthFromEnv(undefined, undefined, {}), undefined);
  assert.equal(
    editorAuthFromEnv(undefined, undefined, { VNS_EDITOR_AUTH_ENABLED: "false" }),
    undefined,
  );
  assert.throws(
    () => editorAuthFromEnv(undefined, undefined, { VNS_EDITOR_AUTH_ENABLED: "true" }),
    /gates/,
  );
  assert.throws(
    () => editorAuthFromEnv(undefined, undefined, { VNS_EDITOR_AUTH_ENABLED: "maybe" }),
    /gates/,
  );
  assert.throws(() => new EditorAuth({} as EditorStore, "http://localhost:3000"), /HTTPS/);
  assert.throws(() => createApiServer({ editor: {} as EditorAuth }), /gates/);
});

test("named sessions use separate secure cookies and prevent shared-review bypass", async () => {
  await serverFixture(async (base, _editor, state) => {
    assert.equal((await fetch(base + "/editor/me")).status, 401);
    assert.equal((await fetch(base + "/editor/auth/login")).status, 405);
    assert.equal(
      (await login(base, "test_editor", PASSWORD, "https://forged.invalid")).status,
      403,
    );
    assert.equal((await login(base, "nonexistent")).status, 401);
    assert.equal((await login(base, "test_editor", "wrong-password-123")).status, 401);
    const success = await login(base);
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { authenticated: true, role: "reviewer" });
    const setCookie = success.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^__Host-vns_editor=[0-9a-f]{64}; Path=\//);
    assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict; Max-Age=900/);
    const cookie = setCookie.split(";")[0] ?? "";
    assert.equal((await fetch(base + "/admin/me", { headers: { Cookie: cookie } })).status, 401);
    assert.deepEqual(
      await (await fetch(base + "/editor/me", { headers: { Cookie: cookie } })).json(),
      { username: "test_editor", role: "reviewer" },
    );
    assert.equal((await review(base, cookie, "https://evil.invalid")).status, 403);
    assert.equal((await review(base, cookie)).status, 200);
    assert.equal(state.reviews, 1);
    const adminLogin = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ password: ADMIN_PASS }),
    });
    const adminCookie = adminLogin.headers.get("set-cookie")?.split(";")[0];
    assert.ok(adminCookie);
    assert.equal(
      (
        await fetch(base + "/admin/evidence/review", {
          method: "POST",
          headers: { Cookie: adminCookie, Origin: ORIGIN, "Content-Type": "application/json" },
          body: JSON.stringify({ evidenceId: EVIDENCE, decision: "verified", reason: REASON }),
        })
      ).status,
      403,
    );
    assert.equal(state.reviews, 1);
    const logout = await fetch(base + "/editor/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: ORIGIN },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await fetch(base + "/editor/me", { headers: { Cookie: cookie } })).status, 401);
  });
});

test("role downgrade and account deactivation take effect on next request", async () => {
  await serverFixture(async (base, _editor, state) => {
    const response = await login(base);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    // Simulate updated database role, not a client-controlled role claim.
    (state.account as { role: string }).role = "editor";
    state.account.authVersion += 1;
    assert.equal((await review(base, cookie)).status, 401);
    assert.equal((await fetch(base + "/editor/me", { headers: { Cookie: cookie } })).status, 401);
    const fresh = await login(base);
    assert.equal(fresh.status, 200);
    const freshCookie = fresh.headers.get("set-cookie")?.split(";")[0];
    assert.ok(freshCookie);
    assert.deepEqual(
      await (await fetch(base + "/editor/me", { headers: { Cookie: freshCookie } })).json(),
      { username: "test_editor", role: "editor" },
    );
    state.account.active = false;
    state.account.authVersion += 1;
    assert.equal((await fetch(base + "/editor/me", { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await review(base, freshCookie)).status, 401);
    assert.equal((await login(base)).status, 401);
    assert.equal(state.reviews, 0);
  });
});

test("login rate limit stops password guessing", async () => {
  await serverFixture(async (base) => {
    for (let i = 0; i < 5; i++) {
      assert.equal((await login(base, "test_editor", "badpasswordlong")).status, 401);
    }
    assert.equal((await login(base)).status, 429);
  });
});

test("password rotation invalidates old sessions even after a quick reactivation", async () => {
  await serverFixture(async (base, _editor, state) => {
    const oldLogin = await login(base);
    assert.equal(oldLogin.status, 200);
    const oldCookie = oldLogin.headers.get("set-cookie")?.split(";")[0];
    assert.ok(oldCookie);
    const newPassword = "ci-rotated-reviewer-password";
    const salt = Buffer.from("c".repeat(32), "hex");
    state.account.passwordHash = `scrypt$${salt.toString("hex")}$${scryptSync(
      newPassword,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    ).toString("hex")}`;
    state.account.authVersion += 1;
    assert.equal((await fetch(base + "/editor/me", { headers: { Cookie: oldCookie } })).status, 401);
    assert.equal((await login(base)).status, 401);
    const rotatedLogin = await login(base, "test_editor", newPassword);
    assert.equal(rotatedLogin.status, 200);
    const rotatedCookie = rotatedLogin.headers.get("set-cookie")?.split(";")[0];
    assert.ok(rotatedCookie);
    state.account.active = false;
    state.account.authVersion += 1;
    state.account.active = true;
    state.account.authVersion += 1;
    assert.equal((await fetch(base + "/editor/me", { headers: { Cookie: rotatedCookie } })).status, 401);
    assert.equal((await login(base, "test_editor", newPassword)).status, 200);
  });
});
