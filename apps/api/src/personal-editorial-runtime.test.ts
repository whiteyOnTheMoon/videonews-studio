import assert from "node:assert/strict";
import test from "node:test";
import {
  createPersonalEditorialSessions,
  readPersonalEditorialAdmission,
} from "./personal-editorial-runtime.js";

const enabled = {
  VNS_EDITORIAL_PERSONAL_DB_ENABLED: "true",
  VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK: "true",
  VNS_EDITORIAL_PERSONAL_DB_HOST: "postgres",
  VNS_EDITORIAL_PERSONAL_DB_SECRETS_DIR: "/run/secrets/vns_editor_credentials",
};

test("personal editorial runtime is OFF by default and rejects partially enabled config", () => {
  assert.equal(readPersonalEditorialAdmission({}), null);
  assert.equal(readPersonalEditorialAdmission({ VNS_EDITORIAL_PERSONAL_DB_ENABLED: "false" }), null);
  assert.deepEqual(readPersonalEditorialAdmission(enabled), {
    pgHost: "postgres",
    secretDirectory: "/run/secrets/vns_editor_credentials",
  });
  for (const settings of [
    { ...enabled, VNS_EDITORIAL_PERSONAL_DB_ENABLED: "false" },
    { ...enabled, VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK: "false" },
    { ...enabled, VNS_EDITORIAL_PERSONAL_DB_HOST: "remote.example.org" },
    { ...enabled, VNS_EDITORIAL_PERSONAL_DB_SECRETS_DIR: "/tmp/keys" },
  ]) assert.throws(() => readPersonalEditorialAdmission(settings));
  assert.throws(() => readPersonalEditorialAdmission({
    VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK: "true",
  }));
});

test("personally bound gateway refuses unauthenticated and non-admin identities before secrets", async () => {
  const admission = readPersonalEditorialAdmission(enabled);
  assert.ok(admission);
  const sessions = createPersonalEditorialSessions(admission);
  const validBase = {
    id: "ca310001-1111-4111-8111-111111111111",
    username: "ci_admin",
    role: "admin" as const,
    authVersion: 0,
  };
  for (const bogus of [
    { ...validBase, role: "editor" },
    { ...validBase, username: "unsafe/../../path" },
    { ...validBase, username: "vns_system" },
    { ...validBase, authVersion: -1 },
  ]) {
    await assert.rejects(
      sessions.open(bogus as never),
      /account refused/,
    );
  }
  await assert.rejects(
    sessions.open(validBase),
    (error: unknown) =>
      error instanceof Error && error.message === "Personal editorial credential unavailable",
  );
});
