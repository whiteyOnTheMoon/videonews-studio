import { createPrivateKey } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { Pool, type QueryResult } from "pg";
import { publishApprovedAdminSourceFile } from "./postgres-admin-source-publisher.js";
import { readApprovedFetchPolicy } from "./source-fetch.js";

export const SOURCE_PUBLISHER_PASSWORD_PATH =
  "/run/secrets/vns_source_export_db_password" as const;
export const SOURCE_PUBLISHER_SIGNING_KEY_PATH =
  "/run/secrets/vns_source_export_signing_key" as const;
export const SOURCE_PUBLISHER_DIRECTORY = "/var/lib/vns/source-publisher" as const;

export interface SourcePublisherAdmission {
  readonly dbHost: "postgres" | "127.0.0.1";
  readonly dbLogin: string;
  readonly passwordPath: typeof SOURCE_PUBLISHER_PASSWORD_PATH;
  readonly privateKeyPath: typeof SOURCE_PUBLISHER_SIGNING_KEY_PATH;
  readonly directory: typeof SOURCE_PUBLISHER_DIRECTORY;
  readonly approvedHosts: string;
}

/**
 * The publisher has no RSS transport, queue, scheduler or API rights.
 * Refuse configuration errors before even opening a secret.
 */
export function readSourcePublisherAdmission(env: NodeJS.ProcessEnv): SourcePublisherAdmission {
  if (
    env.VNS_SOURCE_PUBLISHER_ENABLED !== "true" ||
    env.VNS_SOURCE_PUBLISHER_OPERATOR_ACK !== "true" ||
    env.VNS_SOURCE_PUBLISHER_RIGHTS_ATTESTED !== "true" ||
    env.VNS_SOURCE_PUBLISHER_MODE !== "single_pass" ||
    env.VNS_SOURCE_EXPORT_DB_PASSWORD_FILE !== SOURCE_PUBLISHER_PASSWORD_PATH ||
    env.VNS_SOURCE_EXPORT_SIGNING_KEY_FILE !== SOURCE_PUBLISHER_SIGNING_KEY_PATH ||
    env.VNS_SOURCE_EXPORT_DIRECTORY !== SOURCE_PUBLISHER_DIRECTORY
  ) {
    throw new Error("Source publisher not authorized");
  }
  const dbHost = env.VNS_SOURCE_EXPORT_DB_HOST ?? "";
  const dbLogin = env.VNS_SOURCE_EXPORT_DB_USER ?? "";
  if (
    !["postgres", "127.0.0.1"].includes(dbHost) ||
    !/^vns_source_export_login_[a-z0-9_]{3,24}$/.test(dbLogin)
  ) {
    throw new Error("Source publisher identity not authorized");
  }
  // Parsing only: the publisher itself never connects to approved feed hosts.
  readApprovedFetchPolicy({
    VNS_SOURCE_FETCH_ENABLED: "true",
    VNS_ALLOWED_SOURCE_HOSTS: env.VNS_SOURCE_EXPORT_APPROVED_HOSTS,
  });
  return {
    dbHost: dbHost as SourcePublisherAdmission["dbHost"],
    dbLogin,
    passwordPath: SOURCE_PUBLISHER_PASSWORD_PATH,
    privateKeyPath: SOURCE_PUBLISHER_SIGNING_KEY_PATH,
    directory: SOURCE_PUBLISHER_DIRECTORY,
    approvedHosts: env.VNS_SOURCE_EXPORT_APPROVED_HOSTS!,
  };
}

/** Refuse symlinks, world-accessible, mutable or unexpectedly owned secrets. */
function readPrivateFile(path: string, maxBytes: number): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > maxBytes ||
      (stat.mode & 0o027) !== 0 ||
      (typeof process.getuid === "function" &&
        stat.uid !== 0 &&
        stat.uid !== process.getuid())
    ) {
      throw new Error("Untrusted secret file");
    }
    return readFileSync(descriptor, "utf8");
  } catch {
    throw new Error("Source publisher secret unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export interface ExportPublisherIdentity {
  session_user: string;
  reader_member: boolean;
  can_read_export: boolean;
  can_read_sources: boolean;
  can_read_hosts: boolean;
  can_read_audit: boolean;
  can_edit_sources: boolean;
  superuser: boolean;
  create_role: boolean;
  create_db: boolean;
  replication: boolean;
  bypass_rls: boolean;
}

/** PostgreSQL session_user is not a caller-supplied JSON identity. */
export async function attestSourcePublisherIdentity(
  db: Pick<Pool, "query">,
  expectedLogin: string,
): Promise<void> {
  if (!/^vns_source_export_login_[a-z0-9_]{3,24}$/.test(expectedLogin)) {
    throw new Error("Source export login refused");
  }
  try {
    const result: QueryResult<ExportPublisherIdentity> = await db.query(
      `SELECT session_user,
         pg_has_role(session_user, 'vns_source_export_reader', 'member') AS reader_member,
         has_function_privilege(session_user, 'vns.read_approved_source_export()', 'EXECUTE')
           AS can_read_export,
         has_table_privilege(session_user, 'vns.admin_source_registry', 'SELECT')
           AS can_read_sources,
         has_table_privilege(session_user, 'vns.admin_source_host_approvals', 'SELECT')
           AS can_read_hosts,
         has_table_privilege(session_user, 'vns.admin_source_host_audit', 'SELECT')
           AS can_read_audit,
         has_function_privilege(session_user,
           'vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz)',
           'EXECUTE') AS can_edit_sources,
         rol.rolsuper AS superuser, rol.rolcreaterole AS create_role,
         rol.rolcreatedb AS create_db, rol.rolreplication AS replication,
         rol.rolbypassrls AS bypass_rls
       FROM pg_catalog.pg_roles AS rol WHERE rol.rolname=session_user`,
    );
    const identity = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !identity ||
      identity.session_user !== expectedLogin ||
      identity.reader_member !== true ||
      identity.can_read_export !== true ||
      [
        identity.can_read_sources,
        identity.can_read_hosts,
        identity.can_read_audit,
        identity.can_edit_sources,
        identity.superuser,
        identity.create_role,
        identity.create_db,
        identity.replication,
        identity.bypass_rls,
      ].some((value) => value !== false)
    ) {
      throw new Error("Invalid publisher role");
    }
  } catch {
    throw new Error("Source publisher database admission denied");
  }
}

/** Explicitly invoked one-shot exporter; no worker, timers or live feed reads. */
export async function publishApprovedSourceOnce(env: NodeJS.ProcessEnv = process.env): Promise<{
  sourceRevision: number;
  hostApprovalRevision: number;
}> {
  const admission = readSourcePublisherAdmission(env);
  const password = readPrivateFile(admission.passwordPath, 256).trimEnd();
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(password)) {
    throw new Error("Source publisher secret unavailable");
  }
  const pool = new Pool({
    host: admission.dbHost,
    port: 5432,
    database: "videonews",
    user: admission.dbLogin,
    password,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    application_name: "vns_source_publisher_once",
  });
  try {
    await attestSourcePublisherIdentity(pool, admission.dbLogin);
    const privateKey = createPrivateKey(readPrivateFile(admission.privateKeyPath, 8192));
    if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Unsupported publisher key");
    }
    const policy = readApprovedFetchPolicy({
      VNS_SOURCE_FETCH_ENABLED: "true",
      VNS_ALLOWED_SOURCE_HOSTS: admission.approvedHosts,
    });
    return await publishApprovedAdminSourceFile(
      pool,
      admission.directory,
      policy,
      privateKey,
    );
  } catch {
    throw new Error("Signed source publisher unavailable");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith("/feed-source-publish-once.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--once") {
    console.error("Source publisher requires explicit --once");
    process.exitCode = 2;
  } else {
    try {
      const result = await publishApprovedSourceOnce();
      console.info(
        JSON.stringify({
          event: "signed_source_export_published",
          sourceRevision: result.sourceRevision,
          hostApprovalRevision: result.hostApprovalRevision,
        }),
      );
    } catch {
      console.error("Signed source publisher refused or failed");
      process.exitCode = 1;
    }
  }
}
