import type { KeyObject } from "node:crypto";
import type { AnchorQuery } from "./postgres-source-revision-anchor.js";
import { postgresTrustPolicyAnchor } from "./postgres-trust-policy-anchor.js";
import { pinnedTrustPolicyDigest } from "./source-trust-policy-anchor.js";

/**
 * Bind the currently pinned Ed25519 key to a separate PostgreSQL high-water
 * policy revision BEFORE accepting a signed source export or opening Redis.
 *
 * The initial live rollout permits one existing out-of-band pinned key only.
 * A future key rollover needs an explicitly reviewed epoch policy; never
 * silently accept another key at an unchanged revision.
 */
export async function advancePinnedFeedTrustPolicy(
  anchorDb: AnchorQuery,
  pinnedPublicKey: KeyObject,
  policyRevision: number,
): Promise<void> {
  try {
    const digest = pinnedTrustPolicyDigest({
      policyRevision,
      rotation: {
        epochs: [
          {
            publicKey: pinnedPublicKey,
            fromSourceRevision: 1,
            fromHostApprovalRevision: 1,
          },
        ],
      },
    });
    await postgresTrustPolicyAnchor(anchorDb).advancePolicy(policyRevision, digest);
  } catch {
    // Do not reveal key fingerprints, private paths, SQL or anchor details.
    throw new Error("Independent feed trust policy admission denied");
  }
}
