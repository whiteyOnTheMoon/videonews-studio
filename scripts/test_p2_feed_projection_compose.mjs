import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const FILE = new URL("../deploy/compose.feed-projection.yaml", import.meta.url);
const compose = yaml.load(readFileSync(FILE, "utf8"));
test("projection overlay never runs by default and has no feed transport, queue or signing mounts", () => {
  assert.ok(compose && typeof compose === "object");
  assert.deepEqual(Object.keys(compose.services), ["feed-project-once"]);
  const service = compose.services["feed-project-once"];
  assert.deepEqual(service.profiles, ["feed-project"]);
  assert.deepEqual(service.entrypoint, [
    "node",
    "apps/worker/dist/feed-candidate-project-once.js",
    "--once",
  ]);
  assert.equal(service.user, "10004:10004");
  assert.equal(service.restart, "no");
  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ["ALL"]);
  assert.deepEqual(service.networks, ["backend"]);
  assert.equal(service.ports, undefined);
  assert.equal(service.privileged, undefined);
  assert.equal(service.network_mode, undefined);
  assert.equal(service.environment.VNS_P2_FEED_PROJECTION_MODE, "single_pass");
  assert.equal(service.environment.VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP, "false");
  for (const flag of ["VNS_P2_FEED_PROJECTION_ENABLED", "VNS_P2_FEED_PROJECTION_OPERATOR_ACK"]) {
    assert.equal(service.environment[flag], "${" + flag + ":-false}");
  }
  assert.deepEqual(
    service.volumes.map((x) => x.target),
    ["/run/secrets/vns_feed_project_db_password"],
  );
  assert.equal(service.volumes[0].read_only, true);
  assert.equal(service.volumes[0].bind.create_host_path, false);
  assert.deepEqual(Object.keys(service.volumes[0].bind), ["create_host_path"]);
  assert.deepEqual(service.depends_on, { postgres: { condition: "service_healthy" } });
});
