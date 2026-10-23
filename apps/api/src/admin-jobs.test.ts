import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { AdminAuth } from "./auth.js";
import {
  AdminJobs,
  adminJobsFromEnv,
  parseResearchJobRequest,
  type ResearchJobStore,
} from "./admin-jobs.js";
import { createApiServer } from "./server.js";

const ORIGIN = "https://studio.example.invalid";
const PASSWORD = "ci-admin-job-password";
const SALT = Buffer.alloc(16, 29);
const HASH = `scrypt$${SALT.toString("hex")}$${scryptSync(PASSWORD, SALT, 64, {
  N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
}).toString("hex")}`;
const KEY = "ci_research_job_idempotency_001";
const ID = "de8e2702-7697-4113-9de6-6b81d5582d11";

async function withServer(
  jobs: AdminJobs | undefined,
  auth: AdminAuth,
  callback: (base: string, cookie: string) => Promise<void>,
): Promise<void> {
  const server = createApiServer({ auth, jobs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    await callback(base, cookie);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function submit(base: string, cookie: string | null, body: string, origin = ORIGIN, contentType = "application/json") {
  return fetch(base + "/admin/jobs", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": contentType,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
}

test("admin research job schema requires a narrow payload and strong idempotency key", () => {
  assert.equal(parseResearchJobRequest({ kind: "research", idempotencyKey: KEY }), KEY);
  for (const body of [
    null,
    [],
    { kind: "render", idempotencyKey: KEY },
    { kind: "research", idempotencyKey: "short" },
    { kind: "research", idempotencyKey: KEY, surprise: true },
    { kind: "research", idempotencyKey: "__proto__" },
    { kind: "research" },
  ]) {
    assert.equal(parseResearchJobRequest(body), null);
  }
});

test("admin job configuration fails closed without both auth and PG secret", () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  assert.equal(adminJobsFromEnv(auth, {}), undefined);
  assert.equal(adminJobsFromEnv(auth, { VNS_ADMIN_JOBS_ENABLED: "false" }), undefined);
  assert.throws(() => adminJobsFromEnv(undefined, { VNS_ADMIN_JOBS_ENABLED: "true" }), /auth/);
  assert.throws(() => adminJobsFromEnv(auth, { VNS_ADMIN_JOBS_ENABLED: "true" }), /secret/);
  assert.throws(
    () => adminJobsFromEnv(auth, {
      VNS_ADMIN_JOBS_ENABLED: "true",
      VNS_POSTGRES_PASSWORD_FILE: "/tmp/password",
    }),
    /secret/,
  );
  assert.throws(
    () => adminJobsFromEnv(auth, {
      VNS_ADMIN_JOBS_ENABLED: "true",
      VNS_POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password",
      VNS_POSTGRES_HOST: "outside.example",
    }, () => "a".repeat(40)),
    /endpoint/,
  );
});

test("admin mutation rejects anonymous sessions, CSRF, unsafe inputs and disabled route", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  let requests = 0;
  const store: ResearchJobStore = {
    async createResearchJob() { requests += 1; return ID; },
  };
  await withServer(undefined, auth, async (base, cookie) => {
    assert.equal((await submit(base, cookie, JSON.stringify({ kind: "research", idempotencyKey: KEY }))).status, 404);
  });
  await withServer(new AdminJobs(auth, store), auth, async (base, cookie) => {
    const body = JSON.stringify({ kind: "research", idempotencyKey: KEY });
    assert.equal((await submit(base, null, body)).status, 401);
    assert.equal((await submit(base, "forged=abc", body)).status, 401);
    assert.equal((await submit(base, cookie, body, "https://attacker.example")).status, 403);
    assert.equal((await submit(base, cookie, body, ORIGIN, "text/plain")).status, 400);
    assert.equal((await submit(base, cookie, "{broken")).status, 400);
    assert.equal((await submit(base, cookie, "x".repeat(1100))).status, 400);
    assert.equal((await submit(base, cookie, JSON.stringify({ kind: "upload", idempotencyKey: KEY }))).status, 400);
    assert.equal((await fetch(base + "/admin/jobs", { method: "GET", headers: { Cookie: cookie } })).status, 405);
  });
  assert.equal(requests, 0);
});

test("authenticated idempotent submission returns only a stable UUID; logout blocks reuse", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  const seen = new Map<string, string>();
  let calls = 0;
  const store: ResearchJobStore = {
    async createResearchJob(key) {
      calls += 1;
      if (!seen.has(key)) seen.set(key, ID);
      return seen.get(key) as string;
    },
  };
  await withServer(new AdminJobs(auth, store), auth, async (base, cookie) => {
    const body = JSON.stringify({ kind: "research", idempotencyKey: KEY });
    const first = await submit(base, cookie, body);
    assert.equal(first.status, 202);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(await first.json(), { accepted: true, jobId: ID });
    const second = await submit(base, cookie, body);
    assert.deepEqual(await second.json(), { accepted: true, jobId: ID });
    assert.equal(calls, 2);
    const logout = await fetch(base + "/auth/logout", {
      method: "POST", headers: { Origin: ORIGIN, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.equal((await submit(base, cookie, body)).status, 401);
  });
});

test("database failures and incompatible idempotency reuse are sanitized", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  const failing: ResearchJobStore = {
    async createResearchJob(key) {
      if (key === KEY) throw Object.assign(new Error("secret postgres internal host"), { code: "22023" });
      throw new Error("secret postgres internal host");
    },
  };
  await withServer(new AdminJobs(auth, failing), auth, async (base, cookie) => {
    const conflict = await submit(base, cookie, JSON.stringify({ kind: "research", idempotencyKey: KEY }));
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "idempotency_conflict" });
    const unavailable = await submit(base, cookie, JSON.stringify({
      kind: "research", idempotencyKey: "ci_research_job_idempotency_002",
    }));
    assert.equal(unavailable.status, 503);
    const body = await unavailable.text();
    assert.ok(!body.includes("secret"));
    assert.ok(!body.includes("postgres"));
  });
});
