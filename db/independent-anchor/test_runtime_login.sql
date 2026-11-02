\set ON_ERROR_STOP on
-- Executed ONLY as a synthetic, actually authenticated PostgreSQL LOGIN.
-- Every field mirrors the fail-closed checks in feed-source-anchor-identity.ts.
DO $$
DECLARE
  actual_login text := session_user;
  worker_oid oid := (SELECT oid FROM pg_roles WHERE rolname = session_user);
  can_be_owner boolean;
BEGIN
  IF actual_login <> 'vns_anchor_login_ci_worker'
    OR current_user <> actual_login
    OR worker_oid IS NULL
    OR NOT has_function_privilege(actual_login,
      'vns_source_anchor.advance(bigint,bigint,text)', 'EXECUTE')
    OR NOT has_function_privilege(actual_login,
      'vns_source_anchor.advance_trust_policy(bigint,text)', 'EXECUTE')
    OR has_table_privilege(actual_login,
      'vns_source_anchor.high_water',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_table_privilege(actual_login,
      'vns_source_anchor.trust_policy_high_water',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_table_privilege(actual_login,
      'vns_source_anchor.trust_policy_approvals',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  THEN
    RAISE EXCEPTION 'independent anchor runtime role privilege refused';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_class AS anchor_table
    WHERE anchor_table.oid IN (
      'vns_source_anchor.high_water'::regclass,
      'vns_source_anchor.trust_policy_high_water'::regclass,
      'vns_source_anchor.trust_policy_approvals'::regclass
    )
      AND pg_has_role(worker_oid, anchor_table.relowner, 'MEMBER')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc AS anchor_function
    WHERE anchor_function.oid IN (
      'vns_source_anchor.advance(bigint,bigint,text)'::regprocedure,
      'vns_source_anchor.advance_trust_policy(bigint,text)'::regprocedure
    )
      AND pg_has_role(worker_oid, anchor_function.proowner, 'MEMBER')
  ) INTO can_be_owner;

  IF can_be_owner IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'independent anchor owner membership refused';
  END IF;
END
$$;
