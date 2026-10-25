import type { Pool } from "pg";

/**
 * Dormant PostgreSQL-backed admission gate. A future connection pool must use
 * ONLY the separately approved provider configuration writer login/role.
 * This module is not imported in the running API entrypoint.
 */
export class PostgresProviderMutationLimiter {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async allow(): Promise<boolean> {
    try {
      const result = await this.pool.query<{ allowed: boolean }>(
        "SELECT vns.admin_try_ai_provider_mutation_slot() AS allowed",
      );
      if (result.rows.length !== 1 || typeof result.rows[0]?.allowed !== "boolean") {
        throw new Error("Invalid provider admission result");
      }
      return result.rows[0].allowed;
    } catch {
      // Do not expose database credentials, hostnames or internal SQL errors.
      throw new Error("Provider mutation admission unavailable");
    }
  }
}
