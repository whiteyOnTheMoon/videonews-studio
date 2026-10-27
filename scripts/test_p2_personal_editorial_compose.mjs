import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import yaml from "js-yaml";

const source = readFileSync(new URL("../deploy/compose.personal-editorial-admin.yaml", import.meta.url), "utf8");
const overlay = yaml.load(source);

test("named editorial overlay keeps personal secrets read-only and startup disabled", () => {
  assert.deepEqual(Object.keys(overlay.services), ["api"]);
  const service = overlay.services.api;
  assert.equal(service.privileged, undefined);
  assert.equal(service.ports, undefined);
  assert.equal(service.environment.VNS_EDITORIAL_PERSONAL_DB_ENABLED,
    "${VNS_EDITORIAL_PERSONAL_DB_ENABLED:-false}");
  assert.equal(service.environment.VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK,
    "${VNS_EDITORIAL_PERSONAL_DB_OPERATOR_ACK:-false}");
  assert.equal(service.environment.VNS_EDITORIAL_PERSONAL_DB_HOST, "postgres");
  assert.equal(service.environment.VNS_EDITORIAL_PERSONAL_DB_SECRETS_DIR,
    "/run/secrets/vns_editor_credentials");
  assert.deepEqual(service.volumes.map((x) => x.target), [
    "/run/secrets/vns_editor_credentials",
  ]);
  assert.equal(service.volumes[0].read_only, true);
  assert.equal(service.volumes[0].bind.create_host_path, false);
  assert.equal(service.secrets, undefined);
  assert.equal(service.entrypoint, undefined);
  assert.equal(service.command, undefined);
});
