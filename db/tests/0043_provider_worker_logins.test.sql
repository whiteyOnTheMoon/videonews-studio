-- P1-09 / #230: disposable PostgreSQL identity and ACL test only.
-- CREATE ROLE is rolled back together with all changes.
BEGIN;
CREATE ROLE vns_provider_usage_login LOGIN INHERIT NOSUPERUSER
 NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE vns_provider_secret_login LOGIN INHERIT NOSUPERUSER
 NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT vns_provider_usage_writer TO vns_provider_usage_login
 WITH INHERIT TRUE, SET FALSE;
GRANT vns_provider_secret_reader TO vns_provider_secret_login
 WITH INHERIT TRUE, SET FALSE;
DO $test$
DECLARE r record;
BEGIN
 FOR r IN SELECT rolname AS login,
  rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,
  rolreplication,rolbypassrls
 FROM pg_roles WHERE rolname IN
 ('vns_provider_usage_login','vns_provider_secret_login')
 LOOP
  IF NOT r.rolcanlogin OR NOT r.rolinherit OR r.rolsuper OR
     r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
  THEN RAISE EXCEPTION 'Unsafe provider login %', r.login; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_auth_members m JOIN pg_roles u ON u.oid=m.member
   WHERE u.rolname IN ('vns_provider_usage_login','vns_provider_secret_login'))<>2
 OR (SELECT count(*) FROM pg_auth_members m JOIN pg_roles u ON u.oid=m.member
   WHERE u.rolname IN ('vns_provider_usage_login','vns_provider_secret_login')
     AND m.inherit_option AND NOT m.set_option)<>2
 THEN RAISE EXCEPTION 'Provider worker membership not least privilege'; END IF;
 IF NOT pg_has_role('vns_provider_usage_login','vns_provider_usage_writer','member')
 OR pg_has_role('vns_provider_usage_login','vns_provider_secret_reader','member')
 OR pg_has_role('vns_provider_secret_login','vns_provider_usage_writer','member')
 OR NOT pg_has_role('vns_provider_secret_login','vns_provider_secret_reader','member')
 THEN RAISE EXCEPTION 'Provider DB login role crossing'; END IF;
 IF NOT has_function_privilege('vns_provider_usage_login',
     'vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)','EXECUTE')
 OR NOT has_function_privilege('vns_provider_usage_login',
     'vns.claim_provider_live_dispatch(uuid)','EXECUTE')
 OR NOT has_function_privilege('vns_provider_usage_login',
     'vns.record_provider_usage_evidence(uuid,text,text,text,text,text,bigint,bigint,bigint,bigint)','EXECUTE')
 OR has_function_privilege('vns_provider_usage_login',
     'vns.claimed_provider_sealed_key(uuid,text)','EXECUTE')
 OR has_function_privilege('vns_provider_secret_login',
     'vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)','EXECUTE')
 OR NOT has_function_privilege('vns_provider_secret_login',
     'vns.claimed_provider_sealed_key(uuid,text)','EXECUTE')
 THEN RAISE EXCEPTION 'SQL provider access boundary violated'; END IF;
 IF has_table_privilege('vns_provider_usage_login',
     'vns.ai_provider_sealed_credentials','SELECT')
 OR has_table_privilege('vns_provider_secret_login',
     'vns.ai_provider_sealed_credentials','SELECT')
 OR has_table_privilege('vns_provider_usage_login',
     'vns.provider_live_budget_policy','UPDATE')
 OR has_table_privilege('vns_provider_secret_login',
     'vns.provider_live_budget_policy','UPDATE')
 OR has_table_privilege('vns_provider_secret_login',
     'vns.provider_live_credential_reads','INSERT')
 THEN RAISE EXCEPTION 'Provider login has direct SQL table privileges'; END IF;
 IF EXISTS(SELECT 1 FROM vns.provider_live_credential_reads)
 OR EXISTS(SELECT 1 FROM vns.provider_live_dispatch_claims)
 OR EXISTS(SELECT 1 FROM vns.provider_live_reservations)
 OR EXISTS(SELECT 1 FROM vns.ai_provider_sealed_credentials)
 OR EXISTS(SELECT 1 FROM vns.ai_provider_settings WHERE enabled)
 THEN RAISE EXCEPTION 'Synthetic login test modified runtime data'; END IF;
END;
$test$;
ROLLBACK;
