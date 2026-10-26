import { createHash, type KeyObject } from "node:crypto";
import {
  verifyDormantSourceSignature,
  type SignedDormantSourceExport,
} from "./source-export-signature.js";
import type { RegisteredResearchSource } from "./source-registry.js";
import type { ApprovedFetchPolicy } from "./source-fetch.js";

/**
 * Operator-pinned trust configuration; never parsed from the signed export.
 * This is a dormant, offline-only verification gate, not a key provisioning API.
 */
export interface PinnedSigningKeyEpoch {
  readonly publicKey: KeyObject;
  readonly fromSourceRevision: number;
  readonly fromHostApprovalRevision: number;
  readonly untilSourceRevision?: number;
  readonly untilHostApprovalRevision?: number;
}
export interface PinnedSigningKeyRotation {
  readonly epochs: readonly PinnedSigningKeyEpoch[];
}
const SHA = /^[a-f0-9]{64}$/;
function revision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
export function signingPublicKeyId(key: KeyObject): string {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Invalid pinned signing public key");
  }
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

/**
 * Key selection is based on a separately trusted, explicit revision window.
 * No embedded key ID, remote discovery, fallback or automatic trust promotion.
 * A valid signature with the previous key is refused after its epoch expires.
 */
export function verifyRotatingSourceExport(
  envelope: unknown,
  policy: ApprovedFetchPolicy,
  rotation: PinnedSigningKeyRotation,
  minimum: { sourceRevision: number; hostApprovalRevision: number },
): {
  sealed: SignedDormantSourceExport;
  sources: readonly RegisteredResearchSource[];
  keyId: string;
} {
  if (
    !revision(minimum.sourceRevision) ||
    !revision(minimum.hostApprovalRevision) ||
    !Array.isArray(rotation.epochs) ||
    rotation.epochs.length < 1 ||
    rotation.epochs.length > 8 ||
    !envelope ||
    typeof envelope !== "object" ||
    !("export" in envelope) ||
    !envelope.export ||
    typeof envelope.export !== "object" ||
    !("sourceRevision" in envelope.export) ||
    !("hostApprovalRevision" in envelope.export)
  ) {
    throw new Error("Pinned signing key rotation configuration invalid");
  }
  const proposed = envelope.export;
  const source = proposed.sourceRevision;
  const host = proposed.hostApprovalRevision;
  if (
    typeof source !== "number" ||
    !revision(source) ||
    typeof host !== "number" ||
    !revision(host)
  ) {
    throw new Error("Signed export revision invalid");
  }
  const ids = new Set<string>();
  const eligible: PinnedSigningKeyEpoch[] = [];
  for (const epoch of rotation.epochs) {
    const id = signingPublicKeyId(epoch.publicKey);
    if (
      !SHA.test(id) ||
      ids.has(id) ||
      !revision(epoch.fromSourceRevision) ||
      !revision(epoch.fromHostApprovalRevision) ||
      (epoch.untilSourceRevision !== undefined &&
        (!revision(epoch.untilSourceRevision) ||
          epoch.untilSourceRevision < epoch.fromSourceRevision)) ||
      (epoch.untilHostApprovalRevision !== undefined &&
        (!revision(epoch.untilHostApprovalRevision) ||
          epoch.untilHostApprovalRevision < epoch.fromHostApprovalRevision))
    ) {
      throw new Error("Pinned signing key epoch invalid");
    }
    ids.add(id);
    if (
      source >= epoch.fromSourceRevision &&
      host >= epoch.fromHostApprovalRevision &&
      (epoch.untilSourceRevision === undefined || source <= epoch.untilSourceRevision) &&
      (epoch.untilHostApprovalRevision === undefined || host <= epoch.untilHostApprovalRevision)
    ) {
      eligible.push(epoch);
    }
  }
  if (eligible.length !== 1) {
    throw new Error("No unique authorized signing key for revision");
  }
  const key = eligible[0]!.publicKey;
  const result = verifyDormantSourceSignature(envelope, policy, key, minimum);
  return { ...result, keyId: signingPublicKeyId(key) };
}
