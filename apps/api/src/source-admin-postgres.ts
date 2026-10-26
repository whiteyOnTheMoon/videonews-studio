import type {
  SourceAdminStore,
  SourceAuditEvent,
  SourceSnapshot,
} from "./admin-source-registry.js";
import { validateSourceSnapshot } from "./admin-source-registry.js";

/** Inject an already configured least-privilege pool; never creates connections on import. */
export interface SourceQueryPort {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Unmounted adapter. No secret handling, scheduler activation or runtime wiring. */
export class PostgresSourceAdminStore implements SourceAdminStore {
  constructor(private readonly pool: SourceQueryPort) {}

  async read(): Promise<SourceSnapshot> {
    const result = await this.pool.query(
      "SELECT revision, sources FROM vns.admin_source_registry WHERE singleton = true",
    );
    if (result.rows.length !== 1) throw new Error("Source registry unavailable");
    const row = result.rows[0];
    if (!row) throw new Error("Source registry unavailable");
    const revision = typeof row.revision === "string" ? Number(row.revision) : row.revision;
    return validateSourceSnapshot({ revision, sources: row.sources });
  }

  async saveWithAudit(
    expectedRevision: number,
    next: SourceSnapshot,
    event: SourceAuditEvent,
  ): Promise<"saved" | "conflict"> {
    const validated = validateSourceSnapshot(next);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      validated.revision !== expectedRevision + 1 ||
      event.revision !== validated.revision ||
      !validated.sources.some((source) => source.id === event.sourceId) ||
      !["create_pending", "replace_pending", "approve", "block", "reopen"].includes(event.action) ||
      !/^[0-9a-f-]{36}$/i.test(event.actorId) ||
      !Number.isSafeInteger(event.actorAuthVersion) ||
      event.actorAuthVersion < 0 ||
      !Number.isFinite(Date.parse(event.recordedAt))
    ) {
      throw new Error("Source registry mutation invalid");
    }
    const result = await this.pool.query(
      "SELECT vns.admin_commit_source_registry($1,$2,$3::jsonb,$4,$5,$6::uuid,$7,$8::timestamptz) AS saved",
      [
        expectedRevision,
        validated.revision,
        JSON.stringify(validated.sources),
        event.sourceId,
        event.action,
        event.actorId,
        event.actorAuthVersion,
        event.recordedAt,
      ],
    );
    const response = result.rows[0];
    if (result.rows.length !== 1 || !response || typeof response.saved !== "boolean") {
      throw new Error("Source registry unavailable");
    }
    return response.saved ? "saved" : "conflict";
  }
}
