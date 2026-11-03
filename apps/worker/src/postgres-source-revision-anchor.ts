import type {
  IndependentSourceRevisionAnchor,
  SourceRevisionAnchorState,
} from "./source-export-files.js";

/**
 * An external PostgreSQL authority offers stronger rollback protection.
 * The explicitly approved same-VPS option shares the administration/restore
 * domain but retains the least-privilege SQL gateway. No roles are created here.
 */
export interface AnchorQuery {
  query(
    sql: string,
    parameters: readonly (string | number)[],
  ): Promise<{ rowCount: number | null; rows: Array<{ accepted: unknown }> }>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ADVANCE_SQL =
  "SELECT vns_source_anchor.advance($1::bigint, $2::bigint, $3::text) AS accepted";

/**
 * Atomic, compare-and-advance against an already initialized authority row.
 * The separately owned SECURITY DEFINER function enforces monotonic updates.
 * Only one DB statement runs, so PostgreSQL row locking serializes races.
 */
export function postgresSourceRevisionAnchor(db: AnchorQuery): IndependentSourceRevisionAnchor {
  return {
    async advance(candidate: Readonly<SourceRevisionAnchorState>): Promise<void> {
      if (
        !Number.isSafeInteger(candidate.sourceRevision) ||
        candidate.sourceRevision < 0 ||
        !Number.isSafeInteger(candidate.hostApprovalRevision) ||
        candidate.hostApprovalRevision < 0 ||
        !SHA256.test(candidate.envelopeSha256)
      ) {
        throw new Error("Independent source revision candidate invalid");
      }
      try {
        const result = await db.query(ADVANCE_SQL, [
          candidate.sourceRevision,
          candidate.hostApprovalRevision,
          candidate.envelopeSha256,
        ]);
        if (
          result.rowCount !== 1 ||
          result.rows.length !== 1 ||
          result.rows[0]?.accepted !== true
        ) {
          throw new Error("Independent source revision admission refused");
        }
      } catch {
        // No SQL text, identifiers, credentials or candidate digest in errors.
        throw new Error("Independent source revision admission refused");
      }
    },
  };
}
