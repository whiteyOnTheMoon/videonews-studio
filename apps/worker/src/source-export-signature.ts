import {
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  parseDormantSourceExport,
  type DormantSourceExport,
} from "./source-registry-export.js";
import type { RegisteredResearchSource } from "./source-registry.js";
import type { ApprovedFetchPolicy } from "./source-fetch.js";

export interface SignedDormantSourceExport {
  format: "vns-source-export-ed25519-v1";
  export: DormantSourceExport;
  signature: string;
}
const FORMAT = "vns-source-export-ed25519-v1";
const MAX_SIGNED_BYTES = 49152;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MINIMUM = { sourceRevision: 0, hostApprovalRevision: 0 };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function message(bundle: unknown): Buffer {
  return Buffer.from("VNS source export signature v1\0" + JSON.stringify(bundle), "utf8");
}
function validKey(key: KeyObject, kind: "private" | "public"): boolean {
  return key.type === kind && key.asymmetricKeyType === "ed25519";
}

/**
 * A publisher's independently provisioned Ed25519 private key must never
 * enter the worker image, repository or exported file. No keys are generated
 * or fetched by this module. Signing does NOT grant source network access.
 */
export function sealDormantSourceExport(
  bundle: DormantSourceExport,
  independentlyApprovedPolicy: ApprovedFetchPolicy,
  privateKey: KeyObject,
): SignedDormantSourceExport {
  if (!validKey(privateKey, "private")) {
    throw new Error("Dedicated Ed25519 publisher private key required");
  }
  parseDormantSourceExport(bundle, independentlyApprovedPolicy, MINIMUM);
  const signature = sign(null, message(bundle), privateKey).toString("base64url");
  return { format: FORMAT, export: bundle, signature };
}

/** Verify publisher authenticity and independently trusted allowlist. */
export function verifyDormantSourceSignature(
  value: unknown,
  independentlyTrustedPolicy: ApprovedFetchPolicy,
  pinnedPublicKey: KeyObject,
  minimum: { sourceRevision: number; hostApprovalRevision: number } = MINIMUM,
): { sealed: SignedDormantSourceExport; sources: readonly RegisteredResearchSource[] } {
  if (!validKey(pinnedPublicKey, "public") || !record(value)) {
    throw new Error("Source export publisher identity unavailable");
  }
  if (
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "format") ||
    !Object.hasOwn(value, "export") ||
    !Object.hasOwn(value, "signature") ||
    value.format !== FORMAT ||
    !record(value.export) ||
    typeof value.signature !== "string" ||
    !SIGNATURE.test(value.signature)
  ) {
    throw new Error("Signed source envelope malformed");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SIGNED_BYTES) {
    throw new Error("Signed source export oversized");
  }
  const signature = Buffer.from(value.signature, "base64url");
  if (
    signature.length !== 64 ||
    signature.toString("base64url") !== value.signature ||
    !verify(null, message(value.export), pinnedPublicKey, signature)
  ) {
    throw new Error("Source export signature invalid");
  }
  // Hash is integrity-only. This validation also enforces independently
  // trusted hosts, blocked child scopes and minimum source/host revisions.
  const sources = parseDormantSourceExport(
    value.export,
    independentlyTrustedPolicy,
    minimum,
  );
  return { sealed: value as unknown as SignedDormantSourceExport, sources };
}

export function publisherPublicKey(privateKey: KeyObject): KeyObject {
  if (!validKey(privateKey, "private")) {
    throw new Error("Dedicated Ed25519 publisher private key required");
  }
  return createPublicKey(privateKey);
}
