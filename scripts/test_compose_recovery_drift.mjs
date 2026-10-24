// P1-07: adversarial full-Compose tests with no Docker/SSH/VPS, synthetic changes only.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import yaml from "js-yaml";
import { validateComposeRecoveryDrift } from "./ci_compose_recovery_drift.mjs";

const [source, originalMap, inventory] = await Promise.all([
  readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
  readFile(new URL("../docs/p1-07-compose-recovery-map.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../docs/p1-07-recovery-inventory.json", import.meta.url), "utf8").then(JSON.parse),
]);

function check(compose, map = originalMap, assets = inventory) {
  return validateComposeRecoveryDrift(yaml.dump(compose, { noRefs: true }), map, assets);
}

test("checked-in Compose maps six services, two persistent volumes and two secrets", () => {
  assert.deepEqual(validateComposeRecoveryDrift(source, originalMap, inventory), {
    services: 6,
    volumes: 2,
    secrets: 2,
    profiles: 4,
    productionApproved: false,
  });
});

const mutations = [
  ["new service", (compose) => { compose.services.media = { profiles: ["data"], image: "synthetic-media:ci" }; }],
  ["untracked named volume", (compose) => { compose.volumes.uploads_data = {}; }],
  ["new mounted volume even with a root declaration", (compose) => {
    compose.volumes.uploads_data = {};
    compose.services.worker.volumes = ["uploads_data:/uploads"];
  }],
  ["untracked secret", (compose) => { compose.secrets.upload_token = { file: "./secrets/upload_token" }; }],
  ["new secret mount", (compose) => {
    compose.secrets.upload_token = { file: "./secrets/upload_token" };
    compose.services.worker.secrets = ["upload_token"];
  }],
  ["extra bind mount", (compose) => {
    compose.services.caddy.volumes.push("./private-data:/mnt/data:ro");
  }],
  ["anonymous volume", (compose) => {
    compose.services.worker.volumes = ["/var/lib/work"];
  }],
  ["remove existing persistent volume", (compose) => { delete compose.volumes.redis_data; }],
  ["remove Redis persistence mount", (compose) => { compose.services.redis.volumes = []; }],
  ["change PostgreSQL data volume mount", (compose) => {
    compose.services.postgres.volumes = ["postgres_data:/not-the-database"];
  }],
  ["remove secret from service", (compose) => { compose.services.postgres.secrets = []; }],
  ["remove password secret declaration", (compose) => { delete compose.secrets.postgres_password; }],
  ["change production service profile", (compose) => { compose.services.redis.profiles = ["preview"]; }],
  ["enable automatic startup without a profile", (compose) => { delete compose.services.worker.profiles; }],
  ["introduce public port", (compose) => { compose.services.redis.ports = ["6379:6379"]; }],
  ["enable privileged service", (compose) => { compose.services.worker.privileged = true; }],
  ["introduce unexpected tmpfs", (compose) => { compose.services.api.tmpfs.push("/new-space"); }],
  ["attach additional Compose config", (compose) => { compose.configs = { unknown: { file: "./unknown" } }; }],
  ["mount absolute server path", (compose) => {
    compose.services.worker.volumes = ["/var/run/docker.sock:/var/run/docker.sock"];
  }],
];
for (const [name, change] of mutations) {
  test("fail closed: " + name, () => {
    const parsed = yaml.load(source);
    change(parsed);
    assert.throws(() => check(parsed));
  });
}

test("fails when a newly inventoried volume is falsely marked source-rebuildable", () => {
  const parsed = yaml.load(source);
  parsed.volumes.uploads_data = {};
  const map = structuredClone(originalMap);
  map.volumes.uploads_data = "container-images";
  assert.throws(() => check(parsed, map), /documented data backup/);
});

test("fails when a new bind is mapped to unrelated checked-in source", () => {
  const parsed = yaml.load(source);
  parsed.services.worker.volumes = ["./uploads:/data:ro"];
  const map = structuredClone(originalMap);
  map.services.worker.mounts.push({
    spec: "./uploads:/data:ro",
    inventoryId: "repository-source",
    storage: "repo-bind",
  });
  map.services.worker.inventoryIds.push("repository-source");
  assert.throws(() => check(parsed, map), /tracked source asset/);
});

test("fails when existing named-volume mapping changes to a rebuildable source", () => {
  const map = structuredClone(originalMap);
  map.volumes.redis_data = "container-images";
  assert.throws(() => validateComposeRecoveryDrift(source, map, inventory));
});

test("fails when operator evidence is invented", () => {
  const map = structuredClone(originalMap);
  map.productionVerified = true;
  assert.throws(() => validateComposeRecoveryDrift(source, map, inventory));
});

test("fails when profile map is edited to claim an unknown activation mode", () => {
  const map = structuredClone(originalMap);
  map.profiles.push("live");
  assert.throws(() => validateComposeRecoveryDrift(source, map, inventory));
});
