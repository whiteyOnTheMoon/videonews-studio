import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import {
  PROVIDER_WORKER_PREFLIGHT_FILES,
  readProviderWorkerPreflightAdmission,
  runProviderWorkerReadOnlyPreflight,
} from "./provider-worker-preflight-once.js";
import { PROVIDER_WORKER_DB_IDENTITIES } from "./provider-worker-db-admission.js";

const ENV = {
  VNS_P1_PROVIDER_PREFLIGHT_ENABLED: "true",
  VNS_P1_PROVIDER_PREFLIGHT_OPERATOR_ACK: "true",
  VNS_P1_PROVIDER_PREFLIGHT_MODE: "read_only",
  VNS_P1_PROVIDER_USAGE_PASSWORD_FILE: PROVIDER_WORKER_PREFLIGHT_FILES.usage,
  VNS_P1_PROVIDER_SECRET_PASSWORD_FILE: PROVIDER_WORKER_PREFLIGHT_FILES.secret,
  VNS_P1_PROVIDER_DB_HOST: "postgres",
  VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED: "false",
  VNS_P1_PROVIDER_CANARY_ENABLED: "false",
};
function identity(kind: "usage" | "secret") {
  return {
    session_user: PROVIDER_WORKER_DB_IDENTITIES[kind],
    current_user: PROVIDER_WORKER_DB_IDENTITIES[kind],
    role_member: true,
    other_role_member: false,
    allowed_function: true,
    forbidden_function: false,
    direct_key_read: false,
    direct_key_write: false,
    policy_write: false,
    admin_change: false,
    superuser: false,
    create_role: false,
    create_db: false,
    replication: false,
    bypass_rls: false,
    read_only: true,
  };
}

test("any disabled, non-readonly or unauthorized preflight fails before reading secrets", async () => {
  let reads = 0,
    created = 0;
  const read = () => {
    reads++;
    return "A".repeat(48);
  };
  const factory = () => {
    created++;
    throw Error("should not create DB");
  };
  const negative = [
    {},
    ...Object.keys(ENV)
      .filter(
        (k) =>
          k !== "VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED" && k !== "VNS_P1_PROVIDER_CANARY_ENABLED",
      )
      .map((k) => ({ ...ENV, [k]: undefined })),
    { ...ENV, VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED: "true" },
    { ...ENV, VNS_P1_PROVIDER_CANARY_ENABLED: "true" },
    { ...ENV, VNS_P1_PROVIDER_DB_HOST: "evil.invalid" },
    { ...ENV, VNS_P1_PROVIDER_USAGE_PASSWORD_FILE: "/etc/passwd" },
    { ...ENV, VNS_P1_PROVIDER_SECRET_PASSWORD_FILE: "/run/secrets/postgres_password" },
  ];
  for (const env of negative) {
    assert.throws(() => readProviderWorkerPreflightAdmission(env), /unavailable/);
    await assert.rejects(runProviderWorkerReadOnlyPreflight(env, read, factory), /unavailable/);
  }
  assert.equal(reads, 0);
  assert.equal(created, 0);
});

test("both independent secrets and both read-only authenticated identities are required", async () => {
  const events: string[] = [];
  const dbFactory = (kind: "usage" | "secret", password: string) => {
    events.push("db:" + kind);
    assert.equal(password, kind === "usage" ? "A".repeat(48) : "B".repeat(48));
    return {
      async query(sql: string, args: unknown[]) {
        events.push("inspect:" + kind);
        assert.match(sql, /session_user/);
        assert.ok(args.length === 4);
        return { rows: [identity(kind)] };
      },
      async end() {
        events.push("close:" + kind);
      },
    } as unknown as Pick<Pool, "query" | "end">;
  };
  await runProviderWorkerReadOnlyPreflight(
    ENV,
    (path) => {
      events.push("secret:" + path);
      return path === PROVIDER_WORKER_PREFLIGHT_FILES.usage ? "A".repeat(48) : "B".repeat(48);
    },
    dbFactory,
  );
  assert.deepEqual(events, [
    "secret:" + PROVIDER_WORKER_PREFLIGHT_FILES.usage,
    "secret:" + PROVIDER_WORKER_PREFLIGHT_FILES.secret,
    "db:usage",
    "db:secret",
    "inspect:usage",
    "inspect:secret",
    "close:usage",
    "close:secret",
  ]);
});

test("preflight refuses shared passwords without opening a database connection", async () => {
  let created = 0;
  await assert.rejects(
    runProviderWorkerReadOnlyPreflight(
      ENV,
      () => "A".repeat(48),
      () => {
        created++;
        throw Error("unexpected");
      },
    ),
    /unavailable/,
  );
  assert.equal(created, 0);
});

test("any failed identity query still closes both connections and sanitizes errors", async () => {
  const closed: string[] = [];
  await assert.rejects(
    runProviderWorkerReadOnlyPreflight(
      ENV,
      (path) => (path === PROVIDER_WORKER_PREFLIGHT_FILES.usage ? "A".repeat(48) : "B".repeat(48)),
      (kind) =>
        ({
          async query() {
            if (kind === "secret") throw Error("DATABASE_PASSWORD_LEAK");
            return { rows: [identity(kind)] };
          },
          async end() {
            closed.push(kind);
          },
        }) as unknown as Pick<Pool, "query" | "end">,
    ),
    (error: Error) => error.message === "Provider worker preflight unavailable",
  );
  assert.deepEqual(closed.sort(), ["secret", "usage"]);
});

test("optional Compose preflight is isolated, offline, read-only and never launches providers", () => {
  const overlay = readFileSync(
    new URL("../../../deploy/compose.provider-worker-preflight.yaml", import.meta.url),
    "utf8",
  );
  assert.match(overlay, /profiles: \[provider-preflight\]/);
  assert.match(overlay, /--read-only/);
  assert.match(
    overlay,
    /VNS_P1_PROVIDER_PREFLIGHT_ENABLED: "\$\{VNS_P1_PROVIDER_PREFLIGHT_ENABLED:-false\}"/,
  );
  assert.match(
    overlay,
    /VNS_P1_PROVIDER_PREFLIGHT_OPERATOR_ACK: "\$\{VNS_P1_PROVIDER_PREFLIGHT_OPERATOR_ACK:-false\}"/,
  );
  assert.match(overlay, /VNS_P1_PROVIDER_LIVE_DISPATCH_ENABLED: "false"/);
  assert.match(overlay, /VNS_P1_PROVIDER_CANARY_ENABLED: "false"/);
  assert.match(overlay, /networks: \[backend\]/);
  assert.match(overlay, /read_only: true/);
  assert.match(overlay, /create_host_path: false/g);
  assert.doesNotMatch(
    overlay,
    /^\s+ports:|network_mode: host|api\.openai\.com|generativelanguage/m,
  );
  assert.doesNotMatch(overlay, /provider-master-key|pg_provider_admin_password/);
});
