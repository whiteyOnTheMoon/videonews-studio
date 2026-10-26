import type { Pool } from "pg";
import { readApprovedFetchPolicy } from "./source-fetch.js";
import { ISOLATED_FEED_QUEUE } from "./feed-queue-contract.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "./research-service-config.js";

export const FEED_DB_SECRET = "/run/secrets/vns_feed_db_password" as const;
export const FEED_REDIS_SECRET = "/run/secrets/vns_feed_redis_password" as const;

const REQUIRED_FLAGS = [
  "VNS_FEED_RUNTIME_ENABLED",
  "VNS_FEED_RUNTIME_OPERATOR_ACK",
  "VNS_FEED_RIGHTS_ATTESTED",
  "VNS_FEED_NETWORK_APPROVED",
  "VNS_FEED_OFFLINE_COMPOSITION_ENABLED",
  "VNS_FEED_OFFLINE_OPERATOR_ACK",
  "VNS_FEED_QUEUE_CONTRACT_ENABLED",
  "VNS_FEED_QUEUE_OPERATOR_ACK",
  "VNS_FEED_BULLMQ_BRIDGE_ENABLED",
  "VNS_FEED_BULLMQ_BRIDGE_OPERATOR_ACK",
] as const;

export interface FeedRuntimeAdmission {
  dbUser: string;
  dbHost: string;
  redisHost: string;
  redisUser: string;
  dbSecretPath: typeof FEED_DB_SECRET;
  redisSecretPath: typeof FEED_REDIS_SECRET;
}

/**
 * Synchronous admission gate. Must execute before ANY secret read, DNS
 * resolution, network connection, database session or BullMQ object creation.
 * The first rollout mode is a single manually triggered observation, never cron.
 */
export function readFeedRuntimeAdmission(env: NodeJS.ProcessEnv): FeedRuntimeAdmission {
  if (
    REQUIRED_FLAGS.some((flag) => env[flag] !== "true") ||
    env.VNS_FEED_RUNTIME_MODE !== "single_pass" ||
    env.VNS_FEED_QUEUE_NAME !== ISOLATED_FEED_QUEUE ||
    env.VNS_FEED_REGISTRY_FILE !== REVIEWED_SOURCE_REGISTRY_PATH ||
    env.VNS_FEED_DB_PASSWORD_FILE !== FEED_DB_SECRET ||
    env.VNS_FEED_REDIS_PASSWORD_FILE !== FEED_REDIS_SECRET ||
    env.VNS_SOURCE_FETCH_ENABLED !== "true"
  ) {
    throw new Error("Feed production observation not authorized");
  }
  // Hostnames are fixed Docker-service names or loopback for disposable CI.
  // Arbitrary PG/Redis URLs, connection strings and user-supplied endpoints
  // must never enter a privileged runtime.
  const dbHost = env.VNS_FEED_DB_HOST ?? "";
  const redisHost = env.VNS_FEED_REDIS_HOST ?? "";
  const dbUser = env.VNS_FEED_DB_USER ?? "";
  const redisUser = env.VNS_FEED_REDIS_USER ?? "";
  if (
    !["postgres", "127.0.0.1"].includes(dbHost) ||
    !["redis", "127.0.0.1"].includes(redisHost) ||
    !/^vns_feed_login_[a-z0-9_]{3,24}$/.test(dbUser) ||
    !/^vns_feed_[a-z0-9_]{3,24}$/.test(redisUser) ||
    dbUser === "vns_feed_poll_writer"
  ) {
    throw new Error("Feed runtime identities or endpoints refused");
  }
  // Strictly validate the external allowlist. Never supply a default host.
  readApprovedFetchPolicy(env);
  return Object.freeze({
    dbUser,
    dbHost,
    redisHost,
    redisUser,
    dbSecretPath: FEED_DB_SECRET,
    redisSecretPath: FEED_REDIS_SECRET,
  });
}

export interface FeedDatabaseIdentity {
  session_user: string;
  feed_writer: boolean;
  can_claim: boolean;
  can_commit: boolean;
  can_project: boolean;
  can_read_candidates: boolean;
  can_edit_accounts: boolean;
  superuser: boolean;
  create_role: boolean;
  create_db: boolean;
  replication: boolean;
  bypass_rls: boolean;
}

/**
 * Database-side attestation is mandatory. Do not accept SET ROLE, a browser
 * username, or a shared PostgreSQL connection as a runtime identity.
 * Reject a login that can project, read candidate rows or edit editors.
 */
export async function attestFeedDatabaseIdentity(
  pool: Pick<Pool, "query">,
  expectedLogin: string,
): Promise<void> {
  if (!/^vns_feed_login_[a-z0-9_]{3,24}$/.test(expectedLogin)) {
    throw new Error("Feed database identity refused");
  }
  try {
    const result = await pool.query<FeedDatabaseIdentity>(
      `SELECT session_user,
         pg_has_role(session_user, 'vns_feed_poll_writer', 'member') AS feed_writer,
         has_function_privilege(session_user, 'vns.claim_feed_poll(text,integer)', 'EXECUTE') AS can_claim,
         has_function_privilege(session_user, 'vns.commit_feed_poll(text,uuid,jsonb,text,text)', 'EXECUTE') AS can_commit,
         has_function_privilege(session_user, 'vns.project_feed_candidates(text,integer)', 'EXECUTE') AS can_project,
         has_table_privilege(session_user, 'vns.feed_poll_candidates', 'SELECT') AS can_read_candidates,
         has_table_privilege(session_user, 'vns.editor_accounts', 'UPDATE') AS can_edit_accounts,
         rol.rolsuper AS superuser, rol.rolcreaterole AS create_role,
         rol.rolcreatedb AS create_db, rol.rolreplication AS replication,
         rol.rolbypassrls AS bypass_rls
       FROM pg_roles AS rol WHERE rol.rolname = session_user`,
    );
    const account = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !account ||
      account.session_user !== expectedLogin ||
      account.feed_writer !== true ||
      account.can_claim !== true ||
      account.can_commit !== true ||
      [
        account.can_project,
        account.can_read_candidates,
        account.can_edit_accounts,
        account.superuser,
        account.create_role,
        account.create_db,
        account.replication,
        account.bypass_rls,
      ].some((value) => value !== false)
    ) {
      throw new Error("Incorrect PostgreSQL privileges");
    }
  } catch {
    // Never disclose DB identifiers, SQL, credentials or unexpected grants.
    throw new Error("Feed database admission denied");
  }
}
