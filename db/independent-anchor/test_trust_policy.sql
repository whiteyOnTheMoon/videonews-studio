\set ON_ERROR_STOP on
CREATE ROLE vns_trust_ci_owner NOLOGIN;
CREATE ROLE vns_trust_ci_worker NOLOGIN;
GRANT USAGE ON SCHEMA vns_source_anchor TO vns_trust_ci_owner;
ALTER TABLE vns_source_anchor.trust_policy_high_water OWNER TO vns_trust_ci_owner;
ALTER TABLE vns_source_anchor.trust_policy_approvals OWNER TO vns_trust_ci_owner;
ALTER FUNCTION vns_source_anchor.advance_trust_policy(bigint,text) OWNER TO vns_trust_ci_owner;
GRANT USAGE ON SCHEMA vns_source_anchor TO vns_trust_ci_worker;
GRANT EXECUTE ON FUNCTION vns_source_anchor.advance_trust_policy(bigint,text) TO vns_trust_ci_worker;
-- Synthetically model a separately authenticated operator recording approved
-- signing-key digests; runtime/login is never allowed to insert these rows.
INSERT INTO vns_source_anchor.trust_policy_approvals
  (policy_revision,policy_sha256)
 VALUES (1,repeat('a',64)), (2,repeat('b',64)), (3,repeat('d',64));
INSERT INTO vns_source_anchor.trust_policy_high_water
  (singleton,policy_revision,policy_sha256) VALUES (true,1,repeat('a',64));
DO $$
BEGIN
 IF has_table_privilege('vns_trust_ci_worker','vns_source_anchor.trust_policy_high_water','UPDATE')
 OR has_table_privilege('vns_trust_ci_worker','vns_source_anchor.trust_policy_high_water','INSERT')
 OR has_table_privilege('vns_trust_ci_worker','vns_source_anchor.trust_policy_high_water','SELECT')
 OR has_table_privilege('vns_trust_ci_worker','vns_source_anchor.trust_policy_approvals','SELECT')
 OR has_table_privilege('vns_trust_ci_worker','vns_source_anchor.trust_policy_approvals','INSERT,UPDATE,DELETE')
 OR has_function_privilege('public','vns_source_anchor.advance_trust_policy(bigint,text)','EXECUTE')
 THEN RAISE EXCEPTION 'trust policy privileges too broad'; END IF;
END $$;
SET ROLE vns_trust_ci_worker;
DO $$
BEGIN
 IF NOT vns_source_anchor.advance_trust_policy(1,repeat('a',64))
 OR vns_source_anchor.advance_trust_policy(1,repeat('b',64))

 OR NOT vns_source_anchor.advance_trust_policy(2,repeat('b',64))
 OR vns_source_anchor.advance_trust_policy(1,repeat('a',64))
 OR vns_source_anchor.advance_trust_policy(2,repeat('c',64))
 OR vns_source_anchor.advance_trust_policy(4,repeat('e',64))
 OR vns_source_anchor.advance_trust_policy(3,repeat('e',64))
 THEN RAISE EXCEPTION 'trust policy monotonicity failed'; END IF;
END $$;
RESET ROLE;
-- Approval cannot be manipulated even by SET ROLE to the runtime principal.
-- The denied DML is additionally checked as an actual SQL command in the
-- container runner, rather than relying only on privilege introspection.
