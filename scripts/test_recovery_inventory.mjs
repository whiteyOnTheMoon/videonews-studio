// P1-07: no-network, no-Docker CI validation of documented recovery inventory.
// Read repository files only; never enumerate VPS volumes, credentials or real data.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import test from "node:test";

if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("REFUSED: repository-only inventory test requires GitHub CI");
}

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const INVENTORY_URL = new URL("../docs/p1-07-recovery-inventory.json", import.meta.url);
const PLAN_URL = new URL("../docs/p1-07-recovery-plan.json", import.meta.url);
const REQUIRED_IDS = [
  "repository-source",
  "container-images",
  "compose-definition",
  "caddy-routing",
  "environment-settings",
  "postgres-volume",
  "postgres-global-roles",
  "postgres-secret",
  "redis-aof-volume",
  "redis-acl-secret",
  "redis-worker-password",
  "administrator-password-hash",
  "editor-operator-identities",
  "audit-ledger-records",
  "signed-offsite-audit-archive",
  "uploaded-media",
  "cloudflare-tunnel-config",
  "domain-and-dns",
  "external-publisher-access",
  "pg-redis-outbox-relationship",
  "recovery-signing-keys",
  "backup-encryption-keys",
];

const REQUIRED_BACKUPS = [
  "postgres-volume",
  "postgres-global-roles",
  "redis-aof-volume",
  "audit-ledger-records",
];
const DISPOSITIONS = new Set([
  "backup-required",
  "rebuild",
  "reissue",
  "operator-verify",
  "not-configured",
]);
const CATEGORIES = new Set(["code", "configuration", "data", "credential", "identity", "external", "planned"]);
const EXACT_RECORD_FIELDS = [
  "id",
  "category",
  "disposition",
  "source",
  "dependsOn",
  "recoveryStep",
  "operatorVerified",
  "offsiteBackupVerified",
  "isolatedRestoreVerified",
  "approvedCustodian",
  "backupLocation",
  "evidenceReference",
];

function exactFields(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

export function validateInventory(inventory, plan) {
  exactFields(
    inventory,
    [
      "schemaVersion",
      "scope",
      "productionInventoryVerified",
      "backupDestinationApproved",
      "activationApproved",
      "records",
    ],
    "Inventory schema",
  );
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.scope, "repository-declared-and-operator-review-required");
  assert.equal(inventory.productionInventoryVerified, false);
  assert.equal(inventory.backupDestinationApproved, false);
  assert.equal(inventory.activationApproved, false);
  assert.ok(Array.isArray(inventory.records) && inventory.records.length === REQUIRED_IDS.length);
  assert.ok(Array.isArray(plan.steps));
  const steps = new Set(plan.steps.map((step) => step.id));
  assert.equal(plan.productionApproved, false);
  assert.ok(Object.values(plan.gates).every((v) => v === false));
  const indexed = new Map();
  for (const record of inventory.records) {
    exactFields(record, EXACT_RECORD_FIELDS, "Recovery component");
    assert.match(record.id, /^[a-z][a-z0-9-]{5,49}$/);
    assert.ok(REQUIRED_IDS.includes(record.id), "Unreviewed recovery component");
    assert.ok(!indexed.has(record.id), "Duplicate recovery component");
    indexed.set(record.id, record);
    assert.ok(CATEGORIES.has(record.category) && DISPOSITIONS.has(record.disposition));
    exactFields(record.source, ["path", "anchor"], "Repository evidence pointer");
    assert.match(record.source.path, /^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/);
    assert.ok(!record.source.path.startsWith("secrets/"));
    assert.ok(typeof record.source.anchor === "string" && record.source.anchor.length >= 6);
    assert.ok(record.source.anchor.length <= 120 && !/[\r\n]/.test(record.source.anchor));
    assert.ok(steps.has(record.recoveryStep), "Unknown recovery dependency");
    assert.ok(Array.isArray(record.dependsOn));
    assert.deepEqual(record.dependsOn, [...new Set(record.dependsOn)], "Duplicate dependencies");
    for (const dependency of record.dependsOn) {
      assert.ok(REQUIRED_IDS.includes(dependency), "Unknown component dependency");
      assert.notEqual(dependency, record.id, "Self dependency");
    }
    for (const key of ["operatorVerified", "offsiteBackupVerified", "isolatedRestoreVerified"]) {
      assert.equal(record[key], false, `Unverified claim must remain false: ${record.id}.${key}`);
    }
    for (const key of ["approvedCustodian", "backupLocation", "evidenceReference"]) {
      assert.equal(record[key], null, `No real approval or location has been established: ${record.id}`);
    }
    if (record.category === "code") assert.equal(record.disposition, "rebuild");
    if (record.category === "credential") assert.equal(record.disposition, "reissue");
    if (record.category === "planned") assert.equal(record.disposition, "not-configured");
  }
  assert.deepEqual([...indexed.keys()], REQUIRED_IDS, "Recovery component inventory order/coverage");
  for (const id of REQUIRED_BACKUPS) {
    assert.equal(indexed.get(id).disposition, "backup-required", `Loss of critical backup item ${id}`);
  }
  assert.equal(indexed.get("uploaded-media").disposition, "not-configured");
  assert.equal(indexed.get("cloudflare-tunnel-config").disposition, "operator-verify");
  const visiting = new Set();
  const finished = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error("Recovery component dependency cycle");
    if (finished.has(id)) return;
    visiting.add(id);
    for (const dependency of indexed.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    finished.add(id);
  }
  for (const id of indexed.keys()) visit(id);
  return { components: indexed.size, unverified: indexed.size, releaseApproved: false };
}

const inventory = JSON.parse(await readFile(INVENTORY_URL, "utf8"));
const plan = JSON.parse(await readFile(PLAN_URL, "utf8"));

test("inventory is complete, dependency-safe and refuses all invented backup evidence", () => {
  assert.deepEqual(validateInventory(inventory, plan), {
    components: REQUIRED_IDS.length,
    unverified: REQUIRED_IDS.length,
    releaseApproved: false,
  });
});

test("every declared source pointer resolves to an actual repository anchor", async () => {
  for (const record of inventory.records) {
    const path = resolve(ROOT, record.source.path);
    assert.ok(path.startsWith(ROOT + sep), "Source outside repository");
    const content = await readFile(path, "utf8");
    assert.ok(content.includes(record.source.anchor), `Missing inventory anchor ${record.id}`);
  }
});

const mutations = [
  ["unverified offsite copy marked complete", (x) => (x.records[5].offsiteBackupVerified = true)],
  ["invented custodian", (x) => (x.records[9].approvedCustodian = "fake-owner")],
  ["fabricated backup destination", (x) => (x.records[5].backupLocation = "/fake/offsite")],
  ["invented restore evidence", (x) => (x.records[6].isolatedRestoreVerified = true)],
  ["claim all components checked on VPS", (x) => (x.productionInventoryVerified = true)],
  ["claim backup destination approved", (x) => (x.backupDestinationApproved = true)],
  ["activate recovery", (x) => (x.activationApproved = true)],
  ["remove PostgreSQL role recovery", (x) => x.records.splice(6, 1)],
  ["change Redis AOF into a rebuildable source", (x) => (x.records[8].disposition = "rebuild")],
  ["pretend media storage is deployed", (x) => (x.records[15].disposition = "backup-required")],
  ["hide credential category", (x) => (x.records[11].category = "code")],
  ["invent a secret location", (x) => (x.records[10].backupLocation = "secret.example.invalid")],
  ["add undetected asset", (x) => x.records.push(structuredClone(x.records[0]))],
  ["introduce circular dependency", (x) => x.records[0].dependsOn.push("container-images")],
  ["bypass source pointer path policy", (x) => (x.records[5].source.path = "../secrets/postgres")],
  ["remove restoration step reference", (x) => (x.records[5].recoveryStep = "unknown")],
];
for (const [name, mutate] of mutations) {
  test("fail closed: " + name, () => {
    const copy = structuredClone(inventory);
    mutate(copy);
    assert.throws(() => validateInventory(copy, plan));
  });
}
