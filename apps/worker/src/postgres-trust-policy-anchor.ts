import type { AnchorQuery } from "./postgres-source-revision-anchor.js";
import type { IndependentTrustPolicyAnchor } from "./source-trust-policy-anchor.js";

const SHA256 = /^[a-f0-9]{64}$/;
const SQL =
  "SELECT vns_source_anchor.advance_trust_policy($1::bigint, $2::text) AS accepted";

/** Dormant adapter: requires independently provisioned EXECUTE-only SQL client. */
export function postgresTrustPolicyAnchor(db: AnchorQuery): IndependentTrustPolicyAnchor {
  return {
    async advancePolicy(revision, sha256) {
      if (!Number.isSafeInteger(revision) || revision < 1 || !SHA256.test(sha256)) {
        throw new Error("Invalid trust policy admission candidate");
      }
      try {
        const result = await db.query(SQL, [revision, sha256]);
        if (result.rowCount !== 1 || result.rows.length !== 1 || result.rows[0]?.accepted !== true) {
          throw new Error("Trust policy admission refused");
        }
      } catch {
        throw new Error("Trust policy admission refused");
      }
    },
  };
}
