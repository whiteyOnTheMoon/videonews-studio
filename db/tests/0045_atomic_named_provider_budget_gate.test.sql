-- Disposable PostgreSQL only. Verify direct bypass is revoked and authority
-- is required even when a caller knows the complete reservation identity.
BEGIN;
DO $check$
DECLARE denied boolean:=false;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM vns.schema_migrations
    WHERE version='0045_atomic_named_provider_budget_gate')
 OR has_function_privilege('vns_provider_usage_writer',
   'vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)',
   'EXECUTE')
 OR NOT has_function_privilege('vns_provider_usage_writer',
   'vns.reserve_authorized_provider_live_budget(uuid,text,text,text,uuid,integer,integer,text)',
   'EXECUTE') THEN
   RAISE EXCEPTION 'Unprotected provider reservation writer';
 END IF;
 EXECUTE 'SET LOCAL ROLE vns_provider_usage_writer';
 BEGIN
  PERFORM vns.reserve_provider_live_budget(
   'a4500001-0000-4000-8000-000000000001','openai','ci_model_45',
   'ci_bypass_request_45',
   'a4500002-0000-4000-8000-000000000002',100,32);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Direct reservation bypass accepted'; END IF;
 denied:=false;
 BEGIN
  PERFORM vns.reserve_authorized_provider_live_budget(
   'a4500001-0000-4000-8000-000000000001','openai','ci_model_45',
   'ci_bypass_request_45',
   'a4500002-0000-4000-8000-000000000002',100,32,repeat('a',64));
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 EXECUTE 'RESET ROLE';
 IF NOT denied THEN RAISE EXCEPTION 'Unsigned job admitted'; END IF;
 IF (SELECT count(*) FROM vns.provider_live_reservations)<>0 THEN
   RAISE EXCEPTION 'Unauthorized reservation persisted';
 END IF;
END $check$;
ROLLBACK;
