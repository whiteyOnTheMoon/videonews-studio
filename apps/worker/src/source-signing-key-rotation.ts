import { createHash, type KeyObject } from "node:crypto";
import {
  verifyDormantSourceSignature,
  type SignedDormantSourceExport,
} from "./source-export-signature.js";
import type { RegisteredResearchSource } from "./source-registry.js";
import type { ApprovedFetchPolicy } from "./source-fetch.js";

/** Independently pinned configuration, never obtained from an export. */
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

function revision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function signingPublicKeyId(key: KeyObject): string {
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Invalid pinned signing public key");
  }
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

function validateEpoch(epoch: PinnedSigningKeyEpoch): void {
  if (!revision(epoch.fromSourceRevision) || !revision(epoch.fromHostApprovalRevision)) {
    throw new Error("Pinned signing key epoch invalid");
  }
  if (epoch.untilSourceRevision !== undefined) {
    if (!revision(epoch.untilSourceRevision)) {
      throw new Error("Pinned signing key epoch invalid");
    }
    if (epoch.untilSourceRevision < epoch.fromSourceRevision) {
      throw new Error("Pinned signing key epoch invalid");
    }
  }
  if (epoch.untilHostApprovalRevision !== undefined) {
    if (!revision(epoch.untilHostApprovalRevision)) {
      throw new Error("Pinned signing key epoch invalid");
    }
    if (epoch.untilHostApprovalRevision < epoch.fromHostApprovalRevision) {
      throw new Error("Pinned signing key epoch invalid");
    }
  }
}

function eligible(epoch: PinnedSigningKeyEpoch, source: number, host: number): boolean {
  if (source < epoch.fromSourceRevision || host < epoch.fromHostApprovalRevision) {
    return false;
  }
  if (epoch.untilSourceRevision !== undefined && source > epoch.untilSourceRevision) {
    return false;
  }
  if (epoch.untilHostApprovalRevision !== undefined && host > epoch.untilHostApprovalRevision) {
    return false;
  }
  return true;
}

/** Exactly one out-of-band trusted key must authorize the signed revisions. */
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
  if (!revision(minimum.sourceRevision) || !revision(minimum.hostApprovalRevision)) {
    throw new Error("Pinned signing key rotation configuration invalid");
  }
  if (!Array.isArray(rotation.epochs) || rotation.epochs.length < 1) {
    throw new Error("Pinned signing key rotation configuration invalid");
  }
  if (rotation.epochs.length > 8 || !envelope || typeof envelope !== "object") {
    throw new Error("Pinned signing key rotation configuration invalid");
  }
  if (!("export" in envelope) || !envelope.export || typeof envelope.export !== "object") {
    throw new Error("Pinned signing key rotation configuration invalid");
  }
  if (!("sourceRevision" in envelope.export) || !("hostApprovalRevision" in envelope.export)) {
    throw new Error("Pinned signing key rotation configuration invalid");
  }
  const source = envelope.export.sourceRevision;
  const host = envelope.export.hostApprovalRevision;
  if (typeof source !== "number" || typeof host !== "number") {
    throw new Error("Signed export revision invalid");
  }
  if (!revision(source) || !revision(host)) {
    throw new Error("Signed export revision invalid");
  }
  const ids = new Set<string>();
  const selected: PinnedSigningKeyEpoch[] = [];
  for (const epoch of rotation.epochs) {
    const id = signingPublicKeyId(epoch.publicKey);
    validateEpoch(epoch);
    if (ids.has(id)) {
      throw new Error("Duplicate pinned signing key");
    }
    ids.add(id);
    if (eligible(epoch, source, host)) {
      selected.push(epoch);
    }
  }
  if (selected.length !== 1) {
    throw new Error("No unique authorized signing key for revision");
  }
  const key = selected[0]!.publicKey;
  const result = verifyDormantSourceSignature(envelope, policy, key, minimum);
  return { ...result, keyId: signingPublicKeyId(key) };
}
