import assert from "node:assert/strict";
import test from "node:test";
import {
  POSTGRES_SERVICE_IDENTITIES,
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
