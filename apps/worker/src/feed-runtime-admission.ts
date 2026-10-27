import type { Pool } from "pg";
import { readApprovedFetchPolicy } from "./source-fetch.js";
import { ISOLATED_FEED_QUEUE } from "./feed-queue-contract.js";
import { REVIEWED_SOURCE_REGISTRY_PATH } from "./research-service-config.js";

export const FEED_DB_SECRET = "/run/secrets/vns_feed_db_password" as const;
export const FEED_REDIS_SECRET = "/run/secrets/vns_feed_redis_password" as const;
export const FEED_SOURCE_PUBLIC_KEY = "/run/secrets/vns_feed_source_public_key" as const;
export const FEED_SOURCE_ANCHOR_PASSWORD = "/run/secrets/vns_feed_source_anchor_password" as const;
export const FEED_SOURCE_ANCHOR_CA = "/run/secrets/vns_feed_source_anchor_ca" as const;
export const FEED_SIGNED_SOURCE_INBOX = "/var/lib/vns/feed-source-inbox" as const;
export const FEED_SOURCE_CHECKPOINT = "/var/lib/vns/feed-source-checkpoint" as const;

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
  "VNS_FEED_SIGNED_EXPORT_ENABLED",
  "VNS_FEED_SOURCE_ANCHOR_APPROVED",
] as const;

export type FeedRuntimeMode =
  | "single_pass"
  | "bounded_producer"
  | "continuous_producer"
  | "persistent_worker";

export interface FeedRuntimeAdmission {
  dbUser: string;
  dbHost: string;
  redisHost: string;
  redisUser: string;
  anchorHost: string;
  anchorUser: string;
  initialBootstrap: boolean;
  signedExportDirectory: typeof FEED_SIGNED_SOURCE_INBOX;
  signedCheckpointDirectory: typeof FEED_SOURCE_CHECKPOINT;
  sourcePublicKeyPath: typeof FEED_SOURCE_PUBLIC_KEY;
  anchorPasswordPath: typeof FEED_SOURCE_ANCHOR_PASSWORD;
  anchorCaPath: typeof FEED_SOURCE_ANCHOR_CA;
  dbSecretPath: typeof FEED_DB_SECRET;
  redisSecretPath: typeof FEED_REDIS_SECRET;
}

/**
 * Synchronous admission gate. Must execute before ANY secret read, DNS
 * resolution, network connection, database session or BullMQ object creation.
 * The first rollout mode is a single manually triggered observation, never cron.
 */
export function readFeedRuntimeAdmission(
  env: NodeJS.ProcessEnv,
  expectedMode: FeedRuntimeMode = "single_pass",
): FeedRuntimeAdmission {
  if (!["single_pass", "bounded_producer", "continuous_producer", "persistent_worker"].includes(
    expectedMode,
  )) {
    throw new Error("Feed runtime mode refused");
  }
  if (
    REQUIRED_FLAGS.some((flag) => env[flag] !== "true") ||
    env.VNS_FEED_RUNTIME_MODE !== expectedMode ||
    env.VNS_FEED_QUEUE_NAME !== ISOLATED_FEED_QUEUE ||
    env.VNS_FEED_REGISTRY_FILE !== REVIEWED_SOURCE_REGISTRY_PATH ||
    env.VNS_FEED_DB_PASSWORD_FILE !== FEED_DB_SECRET ||
    env.VNS_FEED_REDIS_PASSWORD_FILE !== FEED_REDIS_SECRET ||
    env.VNS_FEED_SIGNED_SOURCE_INBOX !== FEED_SIGNED_SOURCE_INBOX ||
    env.VNS_FEED_SOURCE_CHECKPOINT_DIR !== FEED_SOURCE_CHECKPOINT ||
    env.VNS_FEED_SOURCE_PUBLIC_KEY_FILE !== FEED_SOURCE_PUBLIC_KEY ||
    env.VNS_FEED_SOURCE_ANCHOR_PASSWORD_FILE !== FEED_SOURCE_ANCHOR_PASSWORD ||
    env.VNS_FEED_SOURCE_ANCHOR_CA_FILE !== FEED_SOURCE_ANCHOR_CA ||
    (env.VNS_FEED_SOURCE_BOOTSTRAP !== "false" && env.VNS_FEED_SOURCE_BOOTSTRAP !== "true") ||
    (env.VNS_FEED_SOURCE_BOOTSTRAP === "true" &&
      env.VNS_FEED_SOURCE_BOOTSTRAP_OPERATOR_ACK !== "true") ||
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
  const anchorHost = env.VNS_FEED_SOURCE_ANCHOR_HOST ?? "";
  const anchorUser = env.VNS_FEED_SOURCE_ANCHOR_USER ?? "";
  if (
    !["postgres", "127.0.0.1"].includes(dbHost) ||
    !["redis", "127.0.0.1"].includes(redisHost) ||
    !/^vns_feed_login_[a-z0-9_]{3,24}$/.test(dbUser) ||
    !/^vns_feed_[a-z0-9_]{3,24}$/.test(redisUser) ||
    dbUser === "vns_feed_poll_writer" ||
    anchorHost.length > 253 ||
    !/^[a-z0-9-]+([.][a-z0-9-]+)+$/.test(anchorHost) ||
    /[.](local|internal|localhost|onion)$/.test(anchorHost) ||
    !/^vns_anchor_login_[a-z0-9_]{3,24}$/.test(anchorUser)
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
    anchorHost,
    anchorUser,
    initialBootstrap: env.VNS_FEED_SOURCE_BOOTSTRAP === "true",
    signedExportDirectory: FEED_SIGNED_SOURCE_INBOX,
    signedCheckpointDirectory: FEED_SOURCE_CHECKPOINT,
    sourcePublicKeyPath: FEED_SOURCE_PUBLIC_KEY,
    anchorPasswordPath: FEED_SOURCE_ANCHOR_PASSWORD,
    anchorCaPath: FEED_SOURCE_ANCHOR_CA,
    dbSecretPath: FEED_DB_SECRET,
    redisSecretPath: FEED_REDIS_SECRET,
  });
}

export interface FeedDatabaseIdentity {
  session_user: string;
  feed_writer: boolean;
  can_claim: boolean;
  can_commit: boolean;
  can_guarded_claim: boolean;
  can_guarded_commit: boolean;
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
         has_function_privilege(session_user, 'vns.claim_feed_poll_authorized(jsonb,integer)', 'EXECUTE') AS can_guarded_claim,
         has_function_privilege(session_user, 'vns.commit_feed_poll_authorized(jsonb,uuid,jsonb,text,text)', 'EXECUTE') AS can_guarded_commit,
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
      account.can_guarded_claim !== true ||
      account.can_guarded_commit !== true ||
      [
        account.can_claim,
        account.can_commit,
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
