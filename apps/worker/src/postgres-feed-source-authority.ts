import type { Pool } from "pg";
import type { RegisteredResearchSource } from "./source-registry.js";

/**
 * This adapter uses the same personally audited source/host approval database
 * as the admin UI, not the worker's potentially stale signed file alone.
 * The restricted feed login only receives EXECUTE on the SQL authority.
 */
export class PostgresFeedSourceAuthority {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async admitted(source: RegisteredResearchSource): Promise<boolean> {
    if (!source || source.status !== "approved") return false;
    try {
      const result = await this.pool.query<{ authorized: boolean }>(
        "SELECT vns.feed_runtime_source_authorized($1::jsonb) AS authorized",
        [JSON.stringify(source)],
      );
      if (result.rows.length !== 1 || typeof result.rows[0]?.authorized !== "boolean") {
        throw new Error("Invalid source authority result");
      }
      return result.rows[0].authorized;
    } catch {
      // Database, personal identity and source details must not escape.
      throw new Error("Feed source authority unavailable");
    }
  }
}
