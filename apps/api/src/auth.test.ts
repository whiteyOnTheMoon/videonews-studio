import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AdminAuth, adminAuthFromEnv } from "./auth.js";
import { createApiServer } from "./server.js";

const ORIGIN = "https://studio.example.invalid";
const PASSWORD = "valid-test-password-only";
const SALT = Buffer.alloc(16, 42);
const HASH = `scrypt$${SALT.toString("hex")}$${scryptSync(PASSWORD, SALT, 64, {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
}).toString("hex")}`;

async function withServer(
  server: Server,
  callback: (base: string) => Promise<void>,
): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function login(base: string, password: string, origin = ORIGIN): Promise<Response> {
  return fetch(base + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ password }),
  });
}

test("authentication is disabled by default; health endpoint remains available", async () => {
  assert.equal(adminAuthFromEnv({}), undefined);
  assert.equal(adminAuthFromEnv({ VNS_ADMIN_AUTH_ENABLED: "false" }), undefined);
  await withServer(createApiServer(), async (base) => {
    const health = await fetch(base + "/healthz");
    assert.equal(health.status, 200);
    assert.equal((await fetch(base + "/auth/login")).status, 404);
    assert.equal((await fetch(base + "/admin/me")).status, 404);
  });
});

test("configuration fails closed without a valid HTTPS origin and scrypt hash", () => {
  assert.throws(() => adminAuthFromEnv({ VNS_ADMIN_AUTH_ENABLED: "true" }));
  assert.throws(() => adminAuthFromEnv({ VNS_ADMIN_AUTH_ENABLED: "yes" }));
  assert.throws(
    () =>
      adminAuthFromEnv({
        VNS_ADMIN_AUTH_ENABLED: "true",
        VNS_ADMIN_PASSWORD_HASH: HASH,
        VNS_ADMIN_ORIGIN: "http://localhost:3000",
      }),
    /HTTPS/,
  );
  assert.throws(() => new AdminAuth({ passwordHash: "plaintext", origin: ORIGIN }), /scrypt/);
  assert.ok(
    adminAuthFromEnv({
      VNS_ADMIN_AUTH_ENABLED: "true",
      VNS_ADMIN_PASSWORD_HASH: HASH,
      VNS_ADMIN_ORIGIN: ORIGIN,
    }) instanceof AdminAuth,
  );
});

test("login requires exact origin; only secure HttpOnly cookies access admin route", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  await withServer(createApiServer({ auth }), async (base) => {
    assert.equal((await fetch(base + "/admin/me")).status, 401);
    assert.equal((await login(base, PASSWORD, "https://evil.example.invalid")).status, 403);
    assert.equal(
      (
        await fetch(base + "/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: PASSWORD }),
        })
      ).status,
      403,
    );
    assert.equal((await login(base, "wrong-password")).status, 401);

    const response = await login(base, PASSWORD);
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);
    assert.match(cookie, /^__Host-vns_session=[0-9a-f]{64}; Path=\//);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=900/);
    const token = cookie.split(";")[0];
    assert.ok(token);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { authenticated: true, role: "admin" });
    assert.ok(!body.includes(token));

    const anonymous = await fetch(base + "/auth/session");
    assert.deepEqual(await anonymous.json(), { authenticated: false });
    const profile = await fetch(base + "/admin/me", { headers: { Cookie: token } });
    assert.equal(profile.status, 200);
    assert.deepEqual(await profile.json(), { role: "admin" });

    const csrf = await fetch(base + "/auth/logout", {
      method: "POST",
      headers: { Cookie: token, Origin: "https://evil.example.invalid" },
    });
    assert.equal(csrf.status, 403);
    assert.equal((await fetch(base + "/admin/me", { headers: { Cookie: token } })).status, 200);

    const logout = await fetch(base + "/auth/logout", {
      method: "POST",
      headers: { Cookie: token, Origin: ORIGIN },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal((await fetch(base + "/admin/me", { headers: { Cookie: token } })).status, 401);
  });
});

test("rate limiting blocks password guessing, then resets after the window", async () => {
  let time = 1000000;
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN, now: () => time });
  await withServer(createApiServer({ auth }), async (base) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login(base, "wrong-password")).status, 401);
    }
    assert.equal((await login(base, PASSWORD)).status, 429);
    time += 5 * 60 * 1000 + 1;
    assert.equal((await login(base, PASSWORD)).status, 200);
  });
});

test("sessions expire and malformed login requests are rejected without secrets", async () => {
  let time = 1000000;
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN, now: () => time });
  await withServer(createApiServer({ auth }), async (base) => {
    const malformed = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{bad-json",
    });
    assert.equal(malformed.status, 400);
    assert.ok(!(await malformed.text()).includes(PASSWORD));
    const success = await login(base, PASSWORD);
    const cookie = success.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.equal((await fetch(base + "/admin/me", { headers: { Cookie: cookie } })).status, 200);
    time += 15 * 60 * 1000 + 1;
    assert.equal((await fetch(base + "/admin/me", { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(base + "/auth/login", { method: "GET" })).status, 405);
  });
});

test("file-backed secret configuration rejects ambiguous, unsafe or missing sources", () => {
  assert.throws(
    () => adminAuthFromEnv({
      VNS_ADMIN_AUTH_ENABLED: "true",
      VNS_ADMIN_ORIGIN: ORIGIN,
      VNS_ADMIN_PASSWORD_HASH: HASH,
      VNS_ADMIN_PASSWORD_HASH_FILE: "/run/secrets/admin_password_hash",
    }),
    /exactly one/,
  );
  assert.throws(
    () => adminAuthFromEnv({
      VNS_ADMIN_AUTH_ENABLED: "true",
      VNS_ADMIN_ORIGIN: ORIGIN,
      VNS_ADMIN_PASSWORD_HASH_FILE: "/tmp/admin_password_hash",
    }),
    /\/run\/secrets/,
  );
  assert.throws(
    () => adminAuthFromEnv({
      VNS_ADMIN_AUTH_ENABLED: "true",
      VNS_ADMIN_ORIGIN: ORIGIN,
      VNS_ADMIN_PASSWORD_HASH_FILE: "/run/secrets/missing_admin_password_hash_file",
    }),
    /unavailable/,
  );
  assert.equal(
    adminAuthFromEnv({
      VNS_ADMIN_AUTH_ENABLED: "false",
      VNS_ADMIN_PASSWORD_HASH_FILE: "/run/secrets/missing_admin_password_hash_file",
    }),
    undefined,
  );
});
