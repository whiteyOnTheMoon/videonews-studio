import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRolloutEvidence, REQUIREMENTS } from "./p2_rollout_gate.mjs";

const sample = () => ({
  schemaVersion: 1,
  mainSha: "a".repeat(40),
  evidence: Object.fromEntries(
    REQUIREMENTS.map((key) => [key, {
      status: "passed",
      approver: "reviewer_01",
      reference: "https://github.com/example/repo/issues/1",
      approvedAt: "2026-10-26T12:00:00Z",
    }]),
  ),
});

test("missing operator evidence blocks rollout review", () => {
  const manifest = sample();
  delete manifest.evidence.independent_anchors;
  const result = evaluateRolloutEvidence(manifest);
  assert.equal(result.readyForOperatorReview, false);
  assert.deepEqual(result.missingOrInvalid, ["independent_anchors"]);
});

test("all evidence requires an explicit review and cannot deploy", () => {
  const result = evaluateRolloutEvidence(sample());
  assert.deepEqual(result, { readyForOperatorReview: true, missingOrInvalid: [] });
});

test("unknown fields, malformed approvals and forged states fail closed", () => {
  const invalid = sample();
  invalid.evidence.source_rights.status = "pending";
  assert.ok(evaluateRolloutEvidence(invalid).missingOrInvalid.includes("source_rights"));
  const unexpected = sample();
  unexpected.evidence.unapproved_gate = {};
  assert.throws(() => evaluateRolloutEvidence(unexpected), /Unknown/);
  const bad = sample();
  bad.mainSha = "main";
  assert.throws(() => evaluateRolloutEvidence(bad), /Invalid/);
});
