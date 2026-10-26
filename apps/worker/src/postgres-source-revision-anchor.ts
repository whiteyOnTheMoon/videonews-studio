import type {
  IndependentSourceRevisionAnchor,
  SourceRevisionAnchorState,
} from "./source-export-files.js";

/**
 * A dedicated PostgreSQL authority must be administered outside the publisher
 * and worker rollback domain. Provision its schema separately; this module
 * neither creates roles nor opens a connection.
 */
export interface AnchorQuery {
  query(
    sql: string,
    parameters: readonly (string | number)[],
  ): Promise<{ rowCount: number | null }>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ADVANCE_SQL = `
UPDATE vns_source_anchor.high_water
SET source_revision = $1,
    host_approval_revision = $2,
    envelope_sha256 = $3
WHERE anchor_id = 'source-export'
  AND source_revision <= $1
  AND host_approval_revision <= $2
  AND (
    source_revision <> $1
    OR host_approval_revision <> $2
    OR envelope_sha256 = $3
  )
RETURNING anchor_id
`;

/**
 * Atomic, compare-and-advance against an already initialized authority row.
 * Zero updated rows means missing bootstrap, rollback or equivocation.
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
        if (result.rowCount !== 1) {
          throw new Error("Independent source revision admission refused");
        }
      } catch {
        // No SQL text, identifiers, credentials or candidate digest in errors.
        throw new Error("Independent source revision admission refused");
      }
    },
  };
}
