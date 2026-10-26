import type { EditorIdentity } from "./editor-auth.js";
import type { SourceQueryPort } from "./source-admin-postgres.js";

/**
 * Offline preflight only: not an authorization substitute for the atomic
 * PostgreSQL host-grant transaction. Must be rechecked inside that transaction.
 */
export class PostgresIndependentSourceReviewPreflight {
  constructor(private readonly queryPort: SourceQueryPort) {}

  async hasIndependentApproval(
    sourceId: string,
    host: string,
    actor: Pick<EditorIdentity, "id" | "authVersion">,
  ): Promise<boolean> {
    if (
      !/^[a-z][a-z0-9_-]{2,40}$/.test(sourceId) ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(actor.id) ||
      !Number.isSafeInteger(actor.authVersion) ||
      actor.authVersion < 0
    ) {
      throw new Error("Independent source review input invalid");
    }

    const rows = await this.queryPort.query(
      `SELECT EXISTS (
        SELECT 1 FROM vns.admin_source_registry registry
        CROSS JOIN LATERAL jsonb_array_elements(registry.sources) AS source(record)
        JOIN vns.admin_source_audit audit
          ON audit.source_id = source.record->>'id' AND audit.action = 'approve'
        JOIN vns.editor_accounts reviewer ON reviewer.id = audit.editor_id
        WHERE registry.singleton = true
          AND source.record->>'id' = $1
          AND source.record->>'status' = 'approved'
          AND split_part(split_part(source.record->>'baseUrl','https://',2),'/',1) = $2
          AND audit.editor_id <> $3::uuid
          AND reviewer.role = 'admin'
      ) AS approved`,
      [sourceId, host, actor.id],
    );
    if (rows.rows.length !== 1 || typeof rows.rows[0]?.approved !== "boolean") {
      throw new Error("Independent source review unavailable");
    }
    return rows.rows[0].approved;
  }
}
