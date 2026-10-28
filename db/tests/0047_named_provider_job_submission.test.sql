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

-- An approved price and disabled selected model permit only one immutable job.
INSERT INTO vns.editor_accounts
 (id,username,display_name,role,password_hash,active,auth_version)
 VALUES ('a4700003-0000-4000-8000-000000000003','ci_provider_47',
 'Provider CI','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true,0);
SET LOCAL ROLE vns_provider_config_writer;
SELECT vns.admin_review_live_provider_price_as_editor(
 'a4700003-0000-4000-8000-000000000003',0,
 'openai','ci_reviewed_47','ci_reviewed_price_0047',
 1000000,200000,2000000,clock_timestamp()+interval '1 day',
 'https://example.org/ci-provider-price');
SELECT vns.admin_mutate_ai_provider_as_editor(
 'openai','set_model','ci_reviewed_47',NULL,NULL,NULL,
 'a4700003-0000-4000-8000-000000000003',0);
RESET ROLE;
DO $approved$
DECLARE price_id uuid; first_id uuid; second_id uuid; denied boolean:=false;
BEGIN
 SELECT id INTO price_id FROM vns.provider_live_price_snapshots
 WHERE provider='openai' AND model='ci_reviewed_47';
 EXECUTE 'SET LOCAL ROLE vns_provider_config_writer';
 SELECT vns.admin_create_sealed_provider_job_as_editor(
  'a4700003-0000-4000-8000-000000000003',0,
  'ci_provider_submission_key_0047',
  'ci_provider_request_0047','openai','ci_reviewed_47',price_id,
  repeat('a',64),100,32,
  'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==','AAAA') INTO first_id;
 SELECT vns.admin_create_sealed_provider_job_as_editor(
  'a4700003-0000-4000-8000-000000000003',0,
  'ci_provider_submission_key_0047',
  'ci_provider_request_0047','openai','ci_reviewed_47',price_id,
  repeat('a',64),100,32,
  'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==','AAAA') INTO second_id;
 BEGIN
  PERFORM vns.admin_create_sealed_provider_job_as_editor(
  'a4700003-0000-4000-8000-000000000003',0,
  'ci_provider_submission_key_0047',
  'ci_provider_request_0047','openai','ci_reviewed_47',price_id,
  repeat('b',64),100,32,
  'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==','AAAA');
 EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 EXECUTE 'RESET ROLE';
 IF first_id IS NULL OR first_id IS DISTINCT FROM second_id OR NOT denied
 OR (SELECT count(*) FROM vns.provider_named_job_authorizations WHERE job_id=first_id)<>1
 OR (SELECT count(*) FROM vns.provider_named_job_sealed_prompts WHERE job_id=first_id)<>1
 OR (SELECT count(*) FROM vns.provider_named_job_outbox WHERE job_id=first_id)<>1
 THEN RAISE EXCEPTION 'Provider job atomic or idempotent creation failed'; END IF;
END $approved$;
ROLLBACK;
