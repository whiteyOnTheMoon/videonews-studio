import type { Pool } from "pg";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CODE = /^[a-z][a-z0-9_]{1,39}$/;
export type CheckpointStage =
  "ranking" | "claim_review" | "freshness" | "script_revision" | "quality";
export type CheckpointOutcome = "candidate" | "blocked" | "needs_review";

export interface CheckpointRecord {
  revision: number;
  stage: CheckpointStage;
  outcome: CheckpointOutcome;
  actor_id: string;
  artifact_sha256: string;
  reason_codes: readonly string[];
  score: number | null;
  previous_sha256: string;
  chain_sha256: string;
  recorded_at: Date;
}

/**
 * Explicit injection only: the Pool must connect with a distinct human
 * PostgreSQL LOGIN. The DB SECURITY DEFINER function authorizes session_user.
 * Supplying a browser user ID or a shared application Pool is NOT sufficient.
 */
export class DormantEditorialCheckpointStore {
  constructor(
    private readonly pool: Pick<Pool, "query">,
    env: NodeJS.ProcessEnv,
  ) {
    if (
      env.VNS_EDITORIAL_CHECKPOINT_OFFLINE_ENABLED !== "true" ||
      env.VNS_EDITORIAL_CHECKPOINT_OPERATOR_ACK !== "true" ||
      !pool ||
      typeof pool.query !== "function"
    ) {
      throw new Error("Named editorial checkpoints disabled");
    }
  }

  async append(
    eventId: string,
    expectedRevision: number,
    stage: CheckpointStage,
    outcome: CheckpointOutcome,
    artifactDigest: string,
    reasons: readonly string[],
    score: number | null,
  ): Promise<"saved" | "conflict"> {
    if (
      !UUID.test(eventId) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision > 9999 ||
      !["ranking", "claim_review", "freshness", "script_revision", "quality"].includes(stage) ||
      !["candidate", "blocked", "needs_review"].includes(outcome) ||
      !DIGEST.test(artifactDigest) ||
      !Array.isArray(reasons) ||
      reasons.length < 1 ||
      reasons.length > 20 ||
      reasons.some((reason) => typeof reason !== "string" || !CODE.test(reason)) ||
      (score !== null && (!Number.isSafeInteger(score) || score < 0 || score > 1000))
    ) {
      throw new Error("Named editorial checkpoint invalid");
    }
    try {
      const result = await this.pool.query<{ saved: boolean }>(
        "SELECT vns.named_append_editorial_checkpoint($1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::jsonb,$7::integer) AS saved",
        [eventId, expectedRevision, stage, outcome, artifactDigest, JSON.stringify(reasons), score],
      );
      if (result.rows.length !== 1 || typeof result.rows[0]?.saved !== "boolean") {
        throw new Error("Unexpected checkpoint result");
      }
      return result.rows[0].saved ? "saved" : "conflict";
    } catch {
      throw new Error("Named editorial checkpoint unavailable");
    }
  }

  async export(
    eventId: string,
    afterRevision: number,
    limit: number,
  ): Promise<readonly CheckpointRecord[]> {
    if (
      !UUID.test(eventId) ||
      !Number.isSafeInteger(afterRevision) ||
      afterRevision < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error("Named editorial checkpoint query invalid");
    }
    try {
      const result = await this.pool.query<CheckpointRecord>(
        "SELECT * FROM vns.named_read_editorial_checkpoints($1::uuid,$2::integer,$3::integer)",
        [eventId, afterRevision, limit],
      );
      if (!Array.isArray(result.rows) || result.rows.length > limit) {
        throw new Error("Unexpected checkpoint export");
      }
      let previous = afterRevision;
      for (const row of result.rows) {
        if (
          !Number.isSafeInteger(row.revision) ||
          row.revision <= previous ||
          !UUID.test(row.actor_id) ||
          !DIGEST.test(row.artifact_sha256) ||
          !DIGEST.test(row.previous_sha256) ||
          !DIGEST.test(row.chain_sha256) ||
          !Array.isArray(row.reason_codes) ||
          row.reason_codes.length < 1 ||
          row.reason_codes.length > 20 ||
          row.reason_codes.some((code) => !CODE.test(code)) ||
          !(row.recorded_at instanceof Date) ||
          !Number.isFinite(row.recorded_at.getTime())
        ) {
          throw new Error("Unexpected checkpoint record");
        }
        previous = row.revision;
      }
      return Object.freeze(result.rows.map((row) => Object.freeze(row)));
    } catch {
      throw new Error("Named editorial checkpoint export unavailable");
    }
  }
}
