-- Disposable PostgreSQL only: no Redis queue, providers or costs.
BEGIN;
DO $acl$
BEGIN
 IF has_table_privilege('vns_provider_config_writer','vns.jobs','INSERT')
    OR has_function_privilege('vns_provider_config_writer',
      'vns.admin_authorize_sealed_provider_job_as_editor(uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text)','EXECUTE')
    OR NOT has_function_privilege('vns_provider_config_writer',
      'vns.admin_create_sealed_provider_job_as_editor(uuid,integer,text,text,text,text,uuid,text,integer,integer,text,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Provider job submission grants unsafe'; END IF;
END $acl$;

-- A missing personal identity must not persist even a pending job.
DO $no_identity$
DECLARE denied boolean:=false;
BEGIN
 EXECUTE 'SET LOCAL ROLE vns_provider_config_writer';
 BEGIN
  PERFORM vns.admin_create_sealed_provider_job_as_editor(
    'a4700001-0000-4000-8000-000000000001',0,
    'ci_provider_submission_key_0047',
    'ci_provider_request_0047','openai','ci_reviewed_47',
    'a4700002-0000-4000-8000-000000000002',
    repeat('a',64),100,32,
    'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==','AAAA');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 EXECUTE 'RESET ROLE';
 IF NOT denied OR EXISTS (
   SELECT 1 FROM vns.jobs
   WHERE idempotency_key='ci_provider_submission_key_0047'
 ) THEN RAISE EXCEPTION 'Unauthenticated job persisted'; END IF;
END $no_identity$;
ROLLBACK;
