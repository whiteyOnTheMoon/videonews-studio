#!/usr/bin/env node
/**
 * P2 release evidence gate. No network, Docker, credentials or filesystem writes.
 * Only verifies operator-supplied evidence; never triggers a deployment.
 */
import { readFileSync } from "node:fs";

export const REQUIREMENTS = Object.freeze([
  "repo_governance",
  "named_db_identities",
  "source_rights",
  "independent_anchors",
  "key_custody_recovery",
  "postgres_restore",
  "redis_recovery",
  "approved_feed_e2e",
  "admin_profile_audit",
  "claims_editorial_review",
  "production_timeline_export",
  "alert_delivery",
  "operator_rollout_approval",
]);

export function evaluateRolloutEvidence(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid P2 evidence manifest");
  }
  if (
    Object.keys(input).sort().join(",") !== "evidence,mainSha,schemaVersion" ||
    input.schemaVersion !== 1 ||
    typeof input.mainSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(input.mainSha) ||
    !input.evidence ||
    typeof input.evidence !== "object" ||
    Array.isArray(input.evidence)
  ) {
    throw new Error("Invalid P2 evidence manifest");
  }
  if (Object.keys(input.evidence).some((key) => !REQUIREMENTS.includes(key))) {
    throw new Error("Unknown P2 evidence gate");
  }
  const failures = [];
  for (const key of REQUIREMENTS) {
    const item = input.evidence[key];
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== "approvedAt,approver,reference,status" ||
      item.status !== "passed" ||
      typeof item.approver !== "string" ||
      !/^[a-zA-Z0-9_.-]{3,80}$/.test(item.approver) ||
      typeof item.reference !== "string" ||
      !/^https:\/\//.test(item.reference) ||
      item.reference.length > 1000 ||
      typeof item.approvedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(item.approvedAt) ||
      !Number.isFinite(Date.parse(item.approvedAt))
    ) {
      failures.push(key);
    }
  }
  return { readyForOperatorReview: failures.length === 0, missingOrInvalid: failures };
}

if (process.argv[1]?.endsWith("/p2_rollout_gate.mjs")) {
  try {
    if (process.argv.length !== 3) throw new Error("Expected one evidence JSON path");
    const data = readFileSync(process.argv[2], "utf8");
    if (Buffer.byteLength(data, "utf8") > 65536) throw new Error("Oversized manifest");
    const result = evaluateRolloutEvidence(JSON.parse(data));
    console.log(JSON.stringify(result));
    // Even complete evidence does not grant permission to operate the VPS.
    process.exitCode = result.readyForOperatorReview ? 0 : 2;
  } catch {
    console.error("P2 rollout evidence invalid or unavailable");
    process.exitCode = 2;
  }
}
