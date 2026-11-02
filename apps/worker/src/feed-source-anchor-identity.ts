import type { Pool } from "pg";

/**
 * A separate TLS-authenticated PostgreSQL cluster must hold the monotonic
 * source revision anchor, beyond the worker/publisher rollback domain.
 * This attests the actual anchor LOGIN, never an application-provided label.
 * No success is returned for an ambiguous or privileged database session.
 */
export interface FeedAnchorIdentity {
  session_user: string;
  can_advance: boolean;
  can_advance_trust_policy: boolean;
  can_read_anchor: boolean;
  can_write_anchor: boolean;
  can_read_policy_anchor: boolean;
  can_write_policy_anchor: boolean;
  can_read_trust_approvals: boolean;
  can_write_trust_approvals: boolean;
  can_assume_authority_owner: boolean;
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
         has_function_privilege(
           session_user,'vns_source_anchor.advance_trust_policy(bigint,text)','EXECUTE'
         ) AS can_advance_trust_policy,
         has_table_privilege(
           session_user,'vns_source_anchor.high_water','SELECT'
         ) AS can_read_anchor,
         has_table_privilege(
           session_user,'vns_source_anchor.high_water',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         ) AS can_write_anchor,
         has_table_privilege(
           session_user,'vns_source_anchor.trust_policy_high_water','SELECT'
         ) AS can_read_policy_anchor,
         has_table_privilege(
           session_user,'vns_source_anchor.trust_policy_high_water',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         ) AS can_write_policy_anchor,
         has_table_privilege(
           session_user,'vns_source_anchor.trust_policy_approvals','SELECT'
         ) AS can_read_trust_approvals,
         has_table_privilege(
           session_user,'vns_source_anchor.trust_policy_approvals',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         ) AS can_write_trust_approvals,
         (
           EXISTS (
             SELECT 1 FROM pg_class AS anchor_table
              WHERE anchor_table.oid IN (
                'vns_source_anchor.high_water'::regclass,
                'vns_source_anchor.trust_policy_high_water'::regclass,
                'vns_source_anchor.trust_policy_approvals'::regclass
              )
              AND pg_has_role(rol.oid,anchor_table.relowner,'MEMBER')
           )
           OR EXISTS (
             SELECT 1 FROM pg_proc AS anchor_function
              WHERE anchor_function.oid IN (
                'vns_source_anchor.advance(bigint,bigint,text)'::regprocedure,
                'vns_source_anchor.advance_trust_policy(bigint,text)'::regprocedure
              )
              AND pg_has_role(rol.oid,anchor_function.proowner,'MEMBER')
           )
         ) AS can_assume_authority_owner,
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
      row.can_advance_trust_policy !== true ||
      [
        row.can_read_anchor,
        row.can_write_anchor,
        row.can_read_policy_anchor,
        row.can_write_policy_anchor,
        row.can_read_trust_approvals,
        row.can_write_trust_approvals,
        row.can_assume_authority_owner,
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
