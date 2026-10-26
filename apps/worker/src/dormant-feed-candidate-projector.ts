import type { Pool } from "pg";

const SOURCE_ID = /^[a-z][a-z0-9_-]{2,40}$/;

/**
 * Offline-only caller-owned SQL port. No connection is opened, no scheduler is
 * registered and the running worker does not import this module.
 *
 * Feature flags are a fail-closed composition guard, NOT a database privilege
 * grant. Function EXECUTE remains ungranted to runtime roles in migration 0028.
 */
export class DormantFeedCandidateProjector {
  constructor(
    private readonly pool: Pool,
    env: NodeJS.ProcessEnv,
  ) {
    if (
      env.VNS_FEED_CANDIDATE_PROJECTION_ENABLED !== "true" ||
      env.VNS_FEED_CANDIDATE_OPERATOR_ACK !== "true" ||
      env.VNS_FEED_OFFLINE_COMPOSITION_ENABLED !== "true" ||
      env.VNS_FEED_OFFLINE_OPERATOR_ACK !== "true" ||
      !pool ||
      typeof pool.query !== "function"
    ) {
      throw new Error("Feed candidate projection disabled");
    }
  }

  /** Project up to the requested candidate count; no claims or reviews written. */
  async project(sourceId: string, limit: number): Promise<number> {
    if (
      typeof sourceId !== "string" ||
      !SOURCE_ID.test(sourceId) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error("Feed candidate projection input invalid");
    }
    try {
      const result = await this.pool.query<{ projected: number }>(
        "SELECT vns.project_feed_candidates($1::text,$2::integer) AS projected",
        [sourceId, limit],
      );
      const count = result.rows[0]?.projected;
      if (
        result.rows.length !== 1 ||
        !Number.isSafeInteger(count) ||
        count === undefined ||
        count < 0 ||
        count > limit
      ) {
        throw new Error("Projection response invalid");
      }
      return count;
    } catch {
      // Do not leak SQL, URLs or repository/private database details to callers.
      throw new Error("Feed candidate projection unavailable");
    }
  }
}
