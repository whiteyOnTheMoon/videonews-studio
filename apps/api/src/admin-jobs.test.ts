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
  validJobSummary,
  validResearchTopic,
  type ResearchJobStore,
} from "./admin-jobs.js";
import { createApiServer } from "./server.js";

const ORIGIN = "https://studio.example.invalid";
const PASSWORD = "ci-admin-job-password";
const SALT = Buffer.alloc(16, 29);
const HASH = `scrypt$${SALT.toString("hex")}$${scryptSync(PASSWORD, SALT, 64, {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
}).toString("hex")}`;
const KEY = "ci_research_job_idempotency_001";
const TOPIC = "Regional mobility projects and public funding";
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

function submit(
  base: string,
  cookie: string | null,
  body: string,
  origin = ORIGIN,
  contentType = "application/json",
) {
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
  assert.deepEqual(
    parseResearchJobRequest({ kind: "research", idempotencyKey: KEY, topic: TOPIC }),
    { idempotencyKey: KEY, topic: TOPIC },
  );
  for (const body of [
    null,
    [],
    { kind: "render", idempotencyKey: KEY, topic: TOPIC },
    { kind: "research", idempotencyKey: "short" },
    { kind: "research", idempotencyKey: KEY, topic: TOPIC, surprise: true },
    { kind: "research", idempotencyKey: KEY },
    { kind: "research", idempotencyKey: KEY, topic: "short" },
    { kind: "research", idempotencyKey: KEY, topic: "  valid research topic  " },
    { kind: "research", idempotencyKey: "__proto__" },
    { kind: "research" },
  ]) {
    assert.equal(parseResearchJobRequest(body), null);
  }
});

test("topic validation rejects controls and overlong code point sequences", () => {
  assert.equal(validResearchTopic(TOPIC), true);
  assert.equal(validResearchTopic("Long enough\nnew line"), false);
  assert.equal(validResearchTopic("a".repeat(161)), false);
  assert.equal(validResearchTopic("  Valid topic length  "), false);
  assert.equal(validResearchTopic("short"), false);
});

test("admin job configuration fails closed without both auth and PG secret", () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  assert.equal(adminJobsFromEnv(auth, {}), undefined);
  assert.equal(adminJobsFromEnv(auth, { VNS_ADMIN_JOBS_ENABLED: "false" }), undefined);
  assert.throws(() => adminJobsFromEnv(undefined, { VNS_ADMIN_JOBS_ENABLED: "true" }), /auth/);
  assert.throws(() => adminJobsFromEnv(auth, { VNS_ADMIN_JOBS_ENABLED: "true" }), /secret/);
  assert.throws(
    () =>
      adminJobsFromEnv(auth, {
        VNS_ADMIN_JOBS_ENABLED: "true",
        VNS_POSTGRES_PASSWORD_FILE: "/tmp/password",
      }),
    /secret/,
  );
  assert.throws(
    () =>
      adminJobsFromEnv(
        auth,
        {
          VNS_ADMIN_JOBS_ENABLED: "true",
          VNS_POSTGRES_PASSWORD_FILE: "/run/secrets/postgres_password",
          VNS_POSTGRES_HOST: "outside.example",
        },
        () => "a".repeat(40),
      ),
    /endpoint/,
  );
});

test("admin mutation rejects anonymous sessions, CSRF, unsafe inputs and disabled route", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  let requests = 0;
  const store: ResearchJobStore = {
    async listRecentResearchJobs() {
      return [];
    },
    async createResearchJob() {
      requests += 1;
      return ID;
    },
  };
  await withServer(undefined, auth, async (base, cookie) => {
    assert.equal(
      (
        await submit(
          base,
          cookie,
          JSON.stringify({ kind: "research", idempotencyKey: KEY, topic: TOPIC }),
        )
      ).status,
      404,
    );
  });
  await withServer(new AdminJobs(auth, store), auth, async (base, cookie) => {
    const body = JSON.stringify({ kind: "research", idempotencyKey: KEY, topic: TOPIC });
    assert.equal((await submit(base, null, body)).status, 401);
    assert.equal((await submit(base, "forged=abc", body)).status, 401);
    assert.equal((await submit(base, cookie, body, "https://attacker.example")).status, 403);
    assert.equal((await submit(base, cookie, body, ORIGIN, "text/plain")).status, 400);
    assert.equal((await submit(base, cookie, "{broken")).status, 400);
    assert.equal((await submit(base, cookie, "x".repeat(1100))).status, 400);
    assert.equal(
      (
        await submit(
          base,
          cookie,
          JSON.stringify({ kind: "upload", idempotencyKey: KEY, topic: TOPIC }),
        )
      ).status,
      400,
    );
    assert.equal(
      (await fetch(base + "/admin/jobs", { method: "GET", headers: { Cookie: cookie } })).status,
      200,
    );
  });
  assert.equal(requests, 0);
});

test("authenticated idempotent submission returns only a stable UUID; logout blocks reuse", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  const seen = new Map<string, string>();
  let calls = 0;
  const store: ResearchJobStore = {
    async listRecentResearchJobs() {
      return [];
    },
    async createResearchJob(key) {
      calls += 1;
      if (!seen.has(key)) seen.set(key, ID);
      return seen.get(key) as string;
    },
  };
  await withServer(new AdminJobs(auth, store), auth, async (base, cookie) => {
    const body = JSON.stringify({ kind: "research", idempotencyKey: KEY, topic: TOPIC });
    const first = await submit(base, cookie, body);
    assert.equal(first.status, 202);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(await first.json(), { accepted: true, jobId: ID });
    const second = await submit(base, cookie, body);
    assert.deepEqual(await second.json(), { accepted: true, jobId: ID });
    assert.equal(calls, 2);
    const logout = await fetch(base + "/auth/logout", {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.equal((await submit(base, cookie, body)).status, 401);
  });
});

test("database failures and incompatible idempotency reuse are sanitized", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  const failing: ResearchJobStore = {
    async listRecentResearchJobs() {
      throw new Error("secret postgres");
    },
    async createResearchJob(key) {
      if (key === KEY)
        throw Object.assign(new Error("secret postgres internal host"), { code: "22023" });
      throw new Error("secret postgres internal host");
    },
  };
  await withServer(new AdminJobs(auth, failing), auth, async (base, cookie) => {
    const conflict = await submit(
      base,
      cookie,
      JSON.stringify({ kind: "research", idempotencyKey: KEY, topic: TOPIC }),
    );
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "idempotency_conflict" });
    const unavailable = await submit(
      base,
      cookie,
      JSON.stringify({
        kind: "research",
        idempotencyKey: "ci_research_job_idempotency_002",
        topic: TOPIC,
      }),
    );
    assert.equal(unavailable.status, 503);
    const body = await unavailable.text();
    assert.ok(!body.includes("secret"));
    assert.ok(!body.includes("postgres"));
  });
});

test("admin job list is session-protected, bounded, narrow and read-only", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  const createdAt = "2026-10-23T18:00:00.000Z";
  const fixture = {
    id: ID,
    kind: "research" as const,
    topic: TOPIC,
    status: "pending" as const,
    deliveryState: "pending" as const,
    createdAt,
  };
  assert.equal(validJobSummary(fixture), true);
  assert.equal(validJobSummary({ ...fixture, idempotencyKey: "private" }), false);
  assert.equal(validJobSummary({ ...fixture, id: "not-a-uuid" }), false);
  assert.equal(validJobSummary({ ...fixture, deliveryState: "published" }), false);
  let reads = 0;
  const store: ResearchJobStore = {
    async createResearchJob() {
      return ID;
    },
    async listRecentResearchJobs() {
      reads += 1;
      return [fixture];
    },
  };
  await withServer(new AdminJobs(auth, store), auth, async (base, cookie) => {
    assert.equal((await fetch(base + "/admin/jobs")).status, 401);
    assert.equal(
      (await fetch(base + "/admin/jobs", { headers: { Cookie: "forged=abc" } })).status,
      401,
    );
    const list = await fetch(base + "/admin/jobs", { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "no-store");
    assert.deepEqual(await list.json(), { jobs: [fixture] });
    assert.equal(reads, 1);
    const badMethod = await fetch(base + "/admin/jobs", {
      method: "PUT",
      headers: { Cookie: cookie },
    });
    assert.equal(badMethod.status, 405);
    assert.equal(reads, 1);
  });
});

test("job listing failures expose no SQL details or unrestricted rows", async () => {
  const auth = new AdminAuth({ passwordHash: HASH, origin: ORIGIN });
  const fake: ResearchJobStore = {
    async createResearchJob() {
      return ID;
    },
    async listRecentResearchJobs() {
      return Array.from({ length: 21 }, () => ({
        id: ID,
        kind: "research",
        topic: null,
        status: "pending",
        deliveryState: "pending",
        createdAt: "2026-10-23T18:00:00.000Z",
      }));
    },
  };
  await withServer(new AdminJobs(auth, fake), auth, async (base, cookie) => {
    const resp = await fetch(base + "/admin/jobs", { headers: { Cookie: cookie } });
    assert.equal(resp.status, 503);
    assert.deepEqual(await resp.json(), { error: "temporarily_unavailable" });
  });
});
