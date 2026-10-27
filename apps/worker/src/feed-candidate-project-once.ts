import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { Pool, type QueryResult } from "pg";

export const PROJECTION_DB_PASSWORD_PATH = "/run/secrets/vns_feed_project_db_password";
const SOURCE = /^[a-z][a-z0-9_-]{2,40}$/;
const LOGIN = /^vns_feed_project_login_[a-z0-9_]{3,24}$/;

export interface ProjectionAdmission {
  readonly dbHost: "postgres" | "127.0.0.1";
  readonly dbUser: string;
  readonly sourceId: string;
  readonly limit: number;
}

export function readProjectionAdmission(env: NodeJS.ProcessEnv): ProjectionAdmission {
  if (
    env.VNS_P2_FEED_PROJECTION_ENABLED !== "true" ||
    env.VNS_P2_FEED_PROJECTION_OPERATOR_ACK !== "true" ||
    env.VNS_P2_FEED_PROJECTION_MODE !== "single_pass" ||
    env.VNS_P2_FEED_PROJECTION_SOURCE_BOOTSTRAP !== "false" ||
    env.VNS_P2_FEED_PROJECTION_DB_PASSWORD_FILE !== PROJECTION_DB_PASSWORD_PATH
  ) {
    throw new Error("P2 candidate projection not approved");
  }
  const dbHost = env.VNS_P2_FEED_PROJECTION_DB_HOST;
  const dbUser = env.VNS_P2_FEED_PROJECTION_DB_USER;
  const sourceId = env.VNS_P2_FEED_PROJECTION_SOURCE_ID;
  const limit = env.VNS_P2_FEED_PROJECTION_LIMIT;
  if (
    !dbHost ||
    !["postgres", "127.0.0.1"].includes(dbHost) ||
    !dbUser ||
    !LOGIN.test(dbUser) ||
    !sourceId ||
    !SOURCE.test(sourceId) ||
    !limit ||
    !/^[1-9][0-9]?$|^100$/.test(limit)
  ) {
    throw new Error("P2 candidate projection identity or bounds refused");
  }
  return { dbHost: dbHost as ProjectionAdmission["dbHost"], dbUser, sourceId, limit: Number(limit) };
}

export interface ProjectionIdentity {
  session_user: string;
  project_member: boolean;
  guarded_execute: boolean;
  raw_execute: boolean;
  direct_candidates: boolean;
  direct_claims: boolean;
  direct_events_write: boolean;
  feed_claim: boolean;
  edit_accounts: boolean;
  superuser: boolean;
  create_role: boolean;
  create_db: boolean;
  replication: boolean;
  bypass_rls: boolean;
}

export async function attestProjectionDatabaseIdentity(
  db: Pick<Pool, "query">,
  expectedLogin: string,
): Promise<void> {
  if (!LOGIN.test(expectedLogin)) throw new Error("Projector DB identity refused");
  try {
    const result: QueryResult<ProjectionIdentity> = await db.query(
      `SELECT session_user,
         pg_has_role(session_user,'vns_feed_project_client','member') AS project_member,
         has_function_privilege(session_user,
           'vns.project_approved_feed_candidates(text,integer)','EXECUTE') AS guarded_execute,
         has_function_privilege(session_user,
           'vns.project_feed_candidates(text,integer)','EXECUTE') AS raw_execute,
         has_table_privilege(session_user,'vns.feed_poll_candidates','SELECT') AS direct_candidates,
         has_table_privilege(session_user,'vns.research_claims','SELECT') AS direct_claims,
         has_table_privilege(session_user,'vns.research_events','INSERT') AS direct_events_write,
         has_function_privilege(session_user,'vns.claim_feed_poll(text,integer)','EXECUTE') AS feed_claim,
         has_table_privilege(session_user,'vns.editor_accounts','UPDATE') AS edit_accounts,
         rol.rolsuper AS superuser,rol.rolcreaterole AS create_role,
         rol.rolcreatedb AS create_db,rol.rolreplication AS replication,
         rol.rolbypassrls AS bypass_rls
       FROM pg_catalog.pg_roles rol WHERE rol.rolname=session_user`,
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 || !row ||
      row.session_user !== expectedLogin ||
      row.project_member !== true || row.guarded_execute !== true ||
      [
        row.raw_execute,row.direct_candidates,row.direct_claims,
        row.direct_events_write,row.feed_claim,row.edit_accounts,
        row.superuser,row.create_role,row.create_db,row.replication,row.bypass_rls,
      ].some((flag) => flag !== false)
    ) throw new Error("Projector privileges invalid");
  } catch {
    throw new Error("P2 projection database admission denied");
  }
}

export async function projectApprovedSource(
  db: Pick<Pool, "query">,
  admission: ProjectionAdmission,
): Promise<number> {
  if (!db || typeof db.query !== "function" || !LOGIN.test(admission.dbUser) ||
      !SOURCE.test(admission.sourceId) || !Number.isSafeInteger(admission.limit) ||
      admission.limit < 1 || admission.limit > 100) {
    throw new Error("P2 projection request invalid");
  }
  await attestProjectionDatabaseIdentity(db, admission.dbUser);
  try {
    const r = await db.query<{ projected: number }>(
      "SELECT vns.project_approved_feed_candidates($1::text,$2::integer) AS projected",
      [admission.sourceId, admission.limit],
    );
    const count = r.rows[0]?.projected;
    if (r.rows.length !== 1 || !Number.isSafeInteger(count) || count === undefined ||
        count < 0 || count > admission.limit) throw new Error("Projection count invalid");
    return count;
  } catch {
    throw new Error("P2 approved source projection unavailable");
  }
}

function readPrivatePassword(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 40 || stat.size > 256 ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid() && stat.uid !== 0)) {
      throw new Error("Unsafe projector secret");
    }
    const value = readFileSync(fd, "utf8").trimEnd();
    if (value.length < 40 || value.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
      throw new Error("Unsafe projector password");
    }
    return value;
  } catch {
    throw new Error("Projector secret unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One-shot no HTTP, queue, scheduler or publisher key. */
export async function runApprovedProjectionOnce(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const admission = readProjectionAdmission(env);
  const password = readPrivatePassword(PROJECTION_DB_PASSWORD_PATH);
  const pool = new Pool({
    host: admission.dbHost,
    port: 5432,
    database: "videonews",
    user: admission.dbUser,
    password,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 5000,
    application_name: "vns_p2_feed_projector",
  });
  try {
    const projected = await projectApprovedSource(pool, admission);
    console.info(JSON.stringify({ event: "p2_approved_feed_projection", projected }));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1]?.endsWith("/feed-candidate-project-once.js")) {
  if (process.argv.length !== 3 || process.argv[2] !== "--once") {
    console.error("Approved projection requires --once");
    process.exitCode = 2;
  } else {
    try {
      await runApprovedProjectionOnce();
    } catch {
      console.error("Approved feed projection refused");
      process.exitCode = 1;
    }
  }
}
