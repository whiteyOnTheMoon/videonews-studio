// P1-07: GitHub-only deterministic contract between Compose and documented recovery assets.
// Full YAML parsing is intentionally delegated to locked js-yaml, NOT regexes or partial parsers.
// Does not invoke Docker, read secret content, touch the VPS or start any service.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const MAP_URL = new URL("../docs/p1-07-compose-recovery-map.json", import.meta.url);
const INVENTORY_URL = new URL("../docs/p1-07-recovery-inventory.json", import.meta.url);
const COMPOSE_URL = new URL("../compose.yaml", import.meta.url);
const NAME = /^[a-z][a-z0-9_-]*$/;

function exactlyKeys(value, keys, label) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label);
}

function asArray(value, label) {
  assert.ok(Array.isArray(value), label);
  return value;
}

function sortedNames(object, label) {
  assert.ok(object && typeof object === "object" && !Array.isArray(object), label);
  return Object.keys(object).sort();
}

function namesOnly(values, label) {
  const array = asArray(values, label);
  for (const value of array) assert.match(value, NAME, label);
  assert.equal(new Set(array).size, array.length, label + " contains duplicates");
  return array;
}

function inventoryLookup(inventory) {
  assert.ok(Array.isArray(inventory.records));
  const result = new Map();
  for (const record of inventory.records) {
    assert.match(record.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(!result.has(record.id), "Duplicate inventory ID");
    result.set(record.id, record);
  }
  return result;
}

export function validateComposeRecoveryDrift(composeText, map, inventory) {
  assert.ok(typeof composeText === "string" && composeText.length > 0);
  const compose = yaml.load(composeText, {
    schema: yaml.DEFAULT_SCHEMA,
    json: false,
  });
  assert.ok(compose && typeof compose === "object" && !Array.isArray(compose));
  exactlyKeys(
    map,
    [
      "schemaVersion",
      "source",
      "scope",
      "productionVerified",
      "recoveryApproved",
      "profiles",
      "services",
      "volumes",
      "secrets",
    ],
    "Compose recovery map",
  );
  assert.equal(map.schemaVersion, 1);
  assert.equal(map.source, "compose.yaml");
  assert.equal(map.scope, "repository-scaffold-only");
  assert.equal(map.productionVerified, false);
  assert.equal(map.recoveryApproved, false);
  assert.equal(compose.name, "videonews-studio");
  for (const unsupported of ["configs", "include", "develop"]) {
    assert.equal(compose[unsupported], undefined, `Untracked Compose ${unsupported}`);
  }

  const assets = inventoryLookup(inventory);
  assert.equal(inventory.productionInventoryVerified, false);
  assert.equal(inventory.backupDestinationApproved, false);
  assert.equal(inventory.activationApproved, false);
  assert.deepEqual(sortedNames(compose.services, "Compose services"), sortedNames(map.services, "Mapped services"));
  assert.deepEqual(sortedNames(compose.volumes, "Compose volumes"), sortedNames(map.volumes, "Mapped volumes"));
  assert.deepEqual(sortedNames(compose.secrets, "Compose secrets"), sortedNames(map.secrets, "Mapped secrets"));
  assert.ok(sortedNames(compose.services, "Compose services").length > 0);

  for (const [volumeName, id] of Object.entries(map.volumes)) {
    assert.match(volumeName, NAME);
    const spec = compose.volumes[volumeName];
    assert.ok(spec !== undefined && spec !== null && typeof spec === "object");
    assert.deepEqual(Object.keys(spec), [], "External/driver-specific volume requires a separate review");
    const asset = assets.get(id);
    assert.ok(asset && asset.category === "data" && asset.disposition === "backup-required",
      `State volume ${volumeName} requires a documented data backup`);
  }
  for (const [secretName, id] of Object.entries(map.secrets)) {
    assert.match(secretName, NAME);
    const spec = compose.secrets[secretName];
    exactlyKeys(spec, ["file"], `Secret declaration ${secretName}`);
    assert.equal(typeof spec.file, "string");
    assert.match(spec.file, /^\.\/secrets\/[a-z0-9_-]+$/);
    const asset = assets.get(id);
    assert.ok(asset && asset.category === "credential" && asset.disposition === "reissue",
      `Secret ${secretName} requires a separate recovery identity`);
    assert.ok(asset.source.path === "compose.yaml",
      `Secret ${secretName} needs a direct Compose evidence reference`);
  }

  const profiles = new Set();
  let mountedVolumes = 0;
  let referencedSecrets = 0;
  for (const [serviceName, service] of Object.entries(compose.services)) {
    assert.match(serviceName, NAME);
    const contract = map.services[serviceName];
    exactlyKeys(
      contract,
      ["inventoryIds", "profiles", "mounts", "secrets", "ephemeralTmpfs"],
      `Service ${serviceName}`,
    );
    const ids = namesOnly(contract.inventoryIds, "Inventory IDs");
    assert.ok(ids.length > 0, `Service ${serviceName} lacks an inventory owner`);
    for (const id of ids) assert.ok(assets.has(id), `Undocumented service ${serviceName} asset ${id}`);

    const declaredProfiles = namesOnly(service.profiles, "Service profiles");
    assert.deepEqual(declaredProfiles, namesOnly(contract.profiles, "Mapped profiles"),
      `Service ${serviceName} changed deployment profiles`);
    for (const profile of declaredProfiles) profiles.add(profile);
    assert.ok(declaredProfiles.length > 0, `Service ${serviceName} would start by default`);

    // A new persistent mount or host bind may never be silently treated as tmpfs.
    const mounts = asArray(service.volumes ?? [], "Service mounts");
    const mappedMounts = asArray(contract.mounts, "Mapped mounts");
    assert.equal(mounts.length, mappedMounts.length, `Service ${serviceName} mount drift`);
    for (let i = 0; i < mounts.length; i += 1) {
      const actual = mounts[i];
      const expected = mappedMounts[i];
      assert.equal(typeof actual, "string", "Unreviewed long-form mount");
      exactlyKeys(expected, ["spec", "inventoryId", "storage"], "Mount recovery map");
      assert.equal(actual, expected.spec, `Service ${serviceName} changed a persistent mount`);
      const parts = actual.split(":");
      assert.ok(parts.length === 2 || parts.length === 3, "Unsupported mount syntax");
      assert.ok(parts[0] && parts[1] && parts[1].startsWith("/"), "Unsupported mount target");
      const asset = assets.get(expected.inventoryId);
      assert.ok(asset, "Mount lacks a recovery asset");
      assert.ok(ids.includes(expected.inventoryId), "Service mount not covered by service recovery");
      if (expected.storage === "named-volume") {
        assert.ok(Object.hasOwn(map.volumes, parts[0]), "Unnamed volume requires review");
        assert.equal(map.volumes[parts[0]], expected.inventoryId);
        assert.ok(asset.category === "data" && asset.disposition === "backup-required");
        assert.equal(parts.length, 2, "Writable volume options require explicit review");
        mountedVolumes += 1;
      } else if (expected.storage === "repo-bind") {
        assert.ok(/^\.\/[a-zA-Z0-9_./-]+$/.test(parts[0]));
        assert.ok(!parts[0].split("/").includes(".."), "Unsafe bind path");
        assert.equal(parts[2], "ro", "Repository config bind must be read-only");
        assert.equal(asset.source.path, parts[0].slice(2),
          "Bind mount is not the tracked source asset");
        assert.equal(asset.disposition, "rebuild", "Repository bind is not rebuildable");
      } else {
        assert.fail("Unknown storage/recovery classification");
      }
    }
    const expectedTmpfs = asArray(contract.ephemeralTmpfs, "Expected ephemeral tmpfs");
    const tmpfs = asArray(service.tmpfs ?? [], "Service tmpfs");
    assert.deepEqual(tmpfs, expectedTmpfs, `Service ${serviceName} tmpfs changed`);

    const usedSecrets = namesOnly(service.secrets ?? [], "Service secrets");
    assert.deepEqual(usedSecrets, namesOnly(contract.secrets, "Mapped service secrets"),
      `Service ${serviceName} secret drift`);
    for (const name of usedSecrets) {
      assert.ok(Object.hasOwn(map.secrets, name), "Undocumented mounted secret");
      assert.ok(ids.includes(map.secrets[name]), "Service missing secret owner");
      referencedSecrets += 1;
    }
    for (const unsupported of [
      "ports",
      "privileged",
      "volumes_from",
      "devices",
      "network_mode",
      "pid",
      "ipc",
      "configs",
    ]) {
      assert.equal(service[unsupported], undefined, `Service ${serviceName}: unreviewed ${unsupported}`);
    }
  }

  assert.deepEqual([...profiles].sort(), namesOnly(map.profiles, "Known Compose profiles").sort(),
    "Unmapped or removed Compose profile");
  // Static guardrails preventing classification changes that accidentally
  // turn critical PostgreSQL/Redis persistence into rebuildable source code.
  assert.equal(map.volumes.postgres_data, "postgres-volume");
  assert.equal(map.volumes.redis_data, "redis-aof-volume");
  assert.equal(map.secrets.postgres_password, "postgres-secret");
  assert.equal(map.secrets.redis_acl, "redis-acl-secret");
  assert.ok(mountedVolumes >= 2);
  assert.ok(referencedSecrets >= 2);
  return {
    services: Object.keys(map.services).length,
    volumes: Object.keys(map.volumes).length,
    secrets: Object.keys(map.secrets).length,
    profiles: map.profiles.length,
    productionApproved: false,
  };
}

if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true") {
  throw new Error("REFUSED: repository-only Compose drift check requires GitHub CI");
}
const [compose, map, inventory] = await Promise.all([
  readFile(COMPOSE_URL, "utf8"),
  readFile(MAP_URL, "utf8").then(JSON.parse),
  readFile(INVENTORY_URL, "utf8").then(JSON.parse),
]);
const result = validateComposeRecoveryDrift(compose, map, inventory);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("PASS: Compose recovery drift contract:", JSON.stringify(result));
}
