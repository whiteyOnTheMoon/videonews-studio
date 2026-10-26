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

test("SHA binding rejects stale or untrusted releases", () => {
  assert.deepEqual(evaluateRolloutEvidence(sample(), { expectedSha: "a".repeat(40) }), {
    readyForOperatorReview: true, missingOrInvalid: [],
  });
  assert.throws(() => evaluateRolloutEvidence(sample(), { expectedSha: "b".repeat(40) }), /SHA mismatch/);
  assert.throws(() => evaluateRolloutEvidence(sample(), { expectedSha: "main" }), /SHA mismatch/);
});

test("future approval, invalid calendar date and URLs with credentials fail closed", () => {
  const cases = [
    { approvedAt: "2099-10-26T12:00:00Z" },
    { approvedAt: "2026-02-30T12:00:00Z" },
    { reference: "https://user:password@example.com/proof" },
    { reference: "https://localhost/proof" },
    { reference: "https://example.com/proof#altered" },
    { reference: "https://example.internal/proof" },
    { reference: "http://example.com/proof" },
  ];
  for (const replacement of cases) {
    const manifest = sample();
    Object.assign(manifest.evidence.source_rights, replacement);
    const result = evaluateRolloutEvidence(manifest, { now: new Date("2026-10-27T00:00:00Z") });
    assert.ok(result.missingOrInvalid.includes("source_rights"), JSON.stringify(replacement));
  }
});

test("invalid evaluation clock cannot silently bypass timestamp checks", () => {
  assert.throws(() => evaluateRolloutEvidence(sample(), { now: new Date("invalid") }), /clock/);
});
