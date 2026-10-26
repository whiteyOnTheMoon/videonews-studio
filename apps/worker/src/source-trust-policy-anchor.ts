import { createHash } from "node:crypto";
import {
  signingPublicKeyId,
  verifyRotatingSourceExport,
  type PinnedSigningKeyRotation,
} from "./source-signing-key-rotation.js";
import type { ApprovedFetchPolicy } from "./source-fetch.js";
import type { RegisteredResearchSource } from "./source-registry.js";

export interface VersionedPinnedTrustPolicy {
  readonly policyRevision: number;
  readonly rotation: PinnedSigningKeyRotation;
}

/** Independently controlled, durable, linearizable compare-and-advance authority. */
export interface IndependentTrustPolicyAnchor {
  advancePolicy(revision: number, sha256: string): Promise<void>;
}

function safeRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Fingerprint only the separately pinned public keys and their revision windows.
 * Never serialize private key objects. Order is material and must be reviewed.
 */
export function pinnedTrustPolicyDigest(policy: VersionedPinnedTrustPolicy): string {
  if (!safeRevision(policy.policyRevision)) {
    throw new Error("Invalid signing trust policy revision");
  }
  const epochs = policy.rotation.epochs;
  if (!Array.isArray(epochs) || epochs.length < 1 || epochs.length > 8) {
    throw new Error("Invalid signing trust policy epochs");
  }
  const records = epochs.map((epoch) => {
    const fromSource = epoch.fromSourceRevision;
    const fromHost = epoch.fromHostApprovalRevision;
    const untilSource = epoch.untilSourceRevision;
    const untilHost = epoch.untilHostApprovalRevision;
    for (const value of [fromSource, fromHost, untilSource, untilHost]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error("Invalid signing trust policy bounds");
      }
    }
    if (untilSource !== undefined && untilSource < fromSource) {
      throw new Error("Invalid signing trust policy bounds");
    }
    if (untilHost !== undefined && untilHost < fromHost) {
      throw new Error("Invalid signing trust policy bounds");
    }
    return [
      signingPublicKeyId(epoch.publicKey),
      fromSource,
      fromHost,
      untilSource ?? null,
      untilHost ?? null,
    ];
  });
  if (new Set(records.map((record) => record[0])).size !== records.length) {
    throw new Error("Duplicate pinned trust key");
  }
  return createHash("sha256")
    .update(JSON.stringify(["vns-source-trust-policy-v1", policy.policyRevision, records]))
    .digest("hex");
}

/**
 * Dormant verification boundary. No source may be released without both the
 * pinned signing-key check and the separately protected policy revision check.
 * An in-process or same-volume anchor is NOT suitable for production.
 */
export async function verifyAnchoredRotatingSourceExport(
  envelope: unknown,
  fetchPolicy: ApprovedFetchPolicy,
  trustPolicy: VersionedPinnedTrustPolicy,
  policyAnchor: IndependentTrustPolicyAnchor,
  minimum: { sourceRevision: number; hostApprovalRevision: number },
): Promise<{ sources: readonly RegisteredResearchSource[]; keyId: string }> {
  const digest = pinnedTrustPolicyDigest(trustPolicy);
  const verified = verifyRotatingSourceExport(envelope, fetchPolicy, trustPolicy.rotation, minimum);
  await policyAnchor.advancePolicy(trustPolicy.policyRevision, digest);
  return { sources: verified.sources, keyId: verified.keyId };
}
