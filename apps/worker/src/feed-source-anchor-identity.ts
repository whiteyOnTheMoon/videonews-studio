import type { Pool } from "pg";

/**
 * A separate TLS-authenticated PostgreSQL cluster must hold the monotonic
 * source revision anchor, beyond the worker/publisher rollback domain.
 * This attests the actual anchor LOGIN, never an application-provided label.
 */
export interface FeedAnchorIdentity {
  session_user: string;
  can_advance: boolean;
  can_read_anchor: boolean;
  superuser: boolean;
  create_role: boolean;
  create_db: boolean;
  replication: boolean;
  bypass_rls: boolean;
}

export async function attestFeedSourceAnchorIdentity(
  pool: Pick<Pool, "query">,
  expectedLogin: string,
): Promise<void> {
  if (!/^vns_anchor_login_[a-z0-9_]{3,24}$/.test(expectedLogin)) {
    throw new Error("Feed source anchor identity refused");
  }
  try {
    const result = await pool.query<FeedAnchorIdentity>(
      `SELECT session_user,
         has_function_privilege(
           session_user,'vns_source_anchor.advance(bigint,bigint,text)','EXECUTE'
         ) AS can_advance,
         has_table_privilege(
           session_user,'vns_source_anchor.high_water','SELECT'
         ) AS can_read_anchor,
         rol.rolsuper AS superuser, rol.rolcreaterole AS create_role,
         rol.rolcreatedb AS create_db, rol.rolreplication AS replication,
         rol.rolbypassrls AS bypass_rls
       FROM pg_roles AS rol WHERE rol.rolname=session_user`,
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      row.session_user !== expectedLogin ||
      row.can_advance !== true ||
      [
        row.can_read_anchor,
        row.superuser,
        row.create_role,
        row.create_db,
        row.replication,
        row.bypass_rls,
      ].some((value) => value !== false)
    ) {
      throw new Error("Untrusted independent anchor login");
    }
  } catch {
    throw new Error("Independent feed source anchor admission denied");
  }
}
