import assert from "node:assert/strict";
import test from "node:test";
import {
  POSTGRES_SERVICE_IDENTITIES,
  readDedicatedPostgresConfig,
  requireDedicatedPostgresIdentity,
} from "./runtime-db.js";

test("distinct database identities are reserved for each service", () => {
  const users = Object.values(POSTGRES_SERVICE_IDENTITIES);
  assert.equal(new Set(users).size, 3);
  assert.equal((users as string[]).includes("vns"), false);
});

test("identity selection fails closed unless separately enabled", () => {
  for (const service of ["dispatch", "statusSync", "research"] as const) {
    assert.throws(() => requireDedicatedPostgresIdentity(service, false), /explicitly enabled/);
    assert.equal(
      requireDedicatedPostgresIdentity(service, true),
      POSTGRES_SERVICE_IDENTITIES[service],
    );
  }
  assert.throws(
    () => requireDedicatedPostgresIdentity("unknown" as never, true),
    /explicitly enabled/,
  );
});

test("separate secrets are required before any runtime database connection", () => {
  const cases = [
    ["dispatch", "/run/secrets/pg_outbox_dispatch_password"],
    ["statusSync", "/run/secrets/pg_job_status_sync_password"],
    ["research", "/run/secrets/pg_research_writer_password"],
  ] as const;
  for (const [service, path] of cases) {
    let reads = 0;
    const reader = (requested: string) => {
      reads++;
      assert.equal(requested, path);
      return "Z".repeat(48);
    };
    assert.throws(() => readDedicatedPostgresConfig(service, {}, reader), /explicitly enabled/);
    assert.equal(reads, 0);
    assert.throws(
      () =>
        readDedicatedPostgresConfig(
          service,
          { VNS_PG_RUNTIME_IDENTITIES_ENABLED: "true", VNS_POSTGRES_RUNTIME_PASSWORD_FILE: "/run/secrets/postgres_password" },
          reader,
        ),
      /path mismatch/,
    );
    assert.equal(reads, 0);
    const env = {
      VNS_PG_RUNTIME_IDENTITIES_ENABLED: "true",
      VNS_POSTGRES_RUNTIME_PASSWORD_FILE: path,
    };
    assert.deepEqual(readDedicatedPostgresConfig(service, env, reader), {
      host: "postgres",
      port: 5432,
      database: "videonews",
      user: POSTGRES_SERVICE_IDENTITIES[service],
      password: "Z".repeat(48),
    });
    assert.equal(reads, 1);
    assert.throws(() => readDedicatedPostgresConfig(service, env, () => "short"), /secret invalid/);
    assert.throws(
      () => readDedicatedPostgresConfig(service, { ...env, VNS_POSTGRES_HOST: "external.example" }, reader),
      /endpoint invalid/,
    );
    assert.equal(reads, 1);
  }
});
