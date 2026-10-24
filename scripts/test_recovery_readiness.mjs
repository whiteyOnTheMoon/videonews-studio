// P1-07 CI-only, pure/offline recovery-readiness contract tests.
// Deliberately NO Docker, SSH, files outside repository, network or VPS actions.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PLAN_URL = new URL("../docs/p1-07-recovery-plan.json", import.meta.url);
const REQUIRED_GATES = [
  "independent_offhost_destination",
  "restorable_offsite_copy",
  "verified_backup_encryption",
  "independent_key_custody",
  "approved_retention_and_privacy",
  "defined_rpo_rto",
  "rehearsed_full_stack_restore",
  "proven_redis_reconciliation",
  "media_recovery_verified",
  "operator_identity_and_mfa",
  "signed_audit_anchor",
  "production_deployment_authorization",
];

const REQUIRED_STEPS = [
  ["freeze_operations", [], "control"],
  ["verify_backup_sources", ["freeze_operations"], "backup"],
  ["prepare_isolated_target", ["verify_backup_sources"], "infrastructure"],
  ["restore_configuration_secrets", ["prepare_isolated_target"], "secrets"],
  ["restore_postgres_globals", ["restore_configuration_secrets"], "postgres_globals"],
  ["restore_postgres_data", ["restore_postgres_globals"], "postgres_data"],
  ["restore_media", ["prepare_isolated_target"], "media"],
  ["verify_audit_archive", ["verify_backup_sources"], "audit"],
  ["restore_redis_or_rebuild", ["restore_postgres_data"], "redis"],
  [
    "reconcile_postgres_outbox",
    ["restore_postgres_data", "restore_redis_or_rebuild"],
    "queue",
  ],
  [
    "reissue_database_logins",
    ["restore_configuration_secrets", "restore_postgres_data"],
    "identity",
  ],
  [
    "start_internal_services_disabled",
    [
      "reconcile_postgres_outbox",
      "restore_media",
      "verify_audit_archive",
      "reissue_database_logins",
    ],
    "services",
  ],
  ["verify_editorial_integrity", ["start_internal_services_disabled"], "verification"],
  ["operator_release_gate", ["verify_editorial_integrity"], "approval"],
];

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

export function validateRecoveryReadiness(plan) {
  exactKeys(
    plan,
    [
      "schemaVersion",
      "mode",
      "productionApproved",
      "allowedExecution",
      "profiles",
      "recoveryObjectives",
      "backup",
      "gates",
      "requiredEvidence",
      "steps",
    ],
    "Recovery plan fields",
  );
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.mode, "offline-design-only");
  assert.equal(plan.productionApproved, false, "Unapproved deployment cannot be activated");
  assert.equal(plan.allowedExecution, "github-actions-validation-only");
  exactKeys(plan.profiles, ["data", "worker", "ingress"], "Feature profiles");
  for (const [name, active] of Object.entries(plan.profiles)) {
    assert.equal(active, false, `Production profile ${name} must stay disabled`);
  }

  exactKeys(plan.recoveryObjectives, ["rpoMinutes", "rtoMinutes"], "Recovery objectives");
  assert.equal(plan.recoveryObjectives.rpoMinutes, null, "RPO requires operator approval");
  assert.equal(plan.recoveryObjectives.rtoMinutes, null, "RTO requires operator approval");
  exactKeys(
    plan.backup,
    ["approvedDestination", "retentionDays", "encryptedArchiveKeyRef", "offsiteCopyVerified"],
    "Backup approval metadata",
  );
  for (const key of ["approvedDestination", "retentionDays", "encryptedArchiveKeyRef"]) {
    assert.equal(plan.backup[key], null, `${key} must not be invented`);
  }
  assert.equal(plan.backup.offsiteCopyVerified, false);

  exactKeys(plan.gates, REQUIRED_GATES, "Release gate inventory");
  exactKeys(plan.requiredEvidence, REQUIRED_GATES, "Uncollected evidence inventory");
  for (const gate of REQUIRED_GATES) {
    assert.equal(plan.gates[gate], false, `Gate ${gate} must remain closed`);
    assert.equal(plan.requiredEvidence[gate], null, `No evidence is approved for ${gate}`);
  }

  assert.ok(Array.isArray(plan.steps), "Restore steps required");
  assert.equal(plan.steps.length, REQUIRED_STEPS.length, "Restore coverage incomplete");
  const visited = new Set();
  for (let i = 0; i < REQUIRED_STEPS.length; i += 1) {
    const step = plan.steps[i];
    const [name, dependsOn, area] = REQUIRED_STEPS[i];
    exactKeys(step, ["id", "dependsOn", "area", "purpose"], `Step ${i}`);
    assert.equal(step.id, name, `Step ${i}: wrong recovery sequence`);
    assert.equal(step.area, area, `Step ${i}: wrong recovery component`);
    assert.deepEqual(step.dependsOn, dependsOn, `Step ${name}: wrong dependencies`);
    assert.ok(
      typeof step.purpose === "string" &&
        step.purpose.trim() === step.purpose &&
        step.purpose.length >= 32 &&
        step.purpose.length <= 300 &&
        !/[\r\n]/.test(step.purpose),
      `Step ${name}: missing operator review description`,
    );
    for (const dependency of dependsOn) {
      assert.ok(visited.has(dependency), `Step ${name} before dependency ${dependency}`);
    }
    assert.ok(!visited.has(name), `Duplicate step ${name}`);
    visited.add(name);
  }
  return { valid: true, closedGates: REQUIRED_GATES.length, steps: visited.size };
}

const plan = JSON.parse(await readFile(PLAN_URL, "utf8"));

test("CI recovery contract is complete and blocked by default", () => {
  assert.deepEqual(validateRecoveryReadiness(plan), {
    valid: true,
    closedGates: 12,
    steps: 14,
  });
});

const attacks = [
  ["silently enables worker", (copy) => (copy.profiles.worker = true)],
  ["enables external ingress", (copy) => (copy.profiles.ingress = true)],
  ["claims deployment approval", (copy) => (copy.productionApproved = true)],
  ["claims backup is already offsite", (copy) => (copy.backup.offsiteCopyVerified = true)],
  ["invents off-host destination", (copy) => (copy.backup.approvedDestination = "s3://fabricated")],
  ["invents RPO objective", (copy) => (copy.recoveryObjectives.rpoMinutes = 5)],
  ["marks a release gate ready", (copy) => (copy.gates.restorable_offsite_copy = true)],
  ["fabricates a signed evidence URI", (copy) => (copy.requiredEvidence.signed_audit_anchor = "claim")],
  ["deletes a recovery step", (copy) => copy.steps.splice(6, 1)],
  ["skips Redis/outbox dependency", (copy) => (copy.steps[9].dependsOn = ["restore_postgres_data"])],
  ["starts services before reconciliation", (copy) => (copy.steps[11].dependsOn = ["restore_postgres_data"])],
  ["changes the startup order", (copy) => copy.steps.reverse()],
  ["removes audit verification", (copy) => copy.steps.splice(7, 1)],
  ["adds unsupported activation mode", (copy) => (copy.mode = "production-ready")],
  ["adds hidden fields", (copy) => (copy.credentials = "some-test-secret")],
];

for (const [name, change] of attacks) {
  test(`fail closed: ${name}`, () => {
    const candidate = structuredClone(plan);
    change(candidate);
    assert.throws(() => validateRecoveryReadiness(candidate));
  });
}
