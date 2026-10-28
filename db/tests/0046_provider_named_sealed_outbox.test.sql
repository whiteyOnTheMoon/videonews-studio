-- Disposable database: only structural and role-boundary checks.
BEGIN;
DO $test$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM vns.schema_migrations
   WHERE version='0046_provider_named_sealed_outbox')
 OR has_table_privilege('vns_provider_usage_writer',
    'vns.provider_named_job_sealed_prompts','SELECT')
 OR has_table_privilege('vns_provider_config_writer',
    'vns.provider_named_job_sealed_prompts','INSERT')
 OR has_function_privilege('vns_provider_config_writer',
    'vns.admin_authorize_provider_job_as_editor(uuid,integer,uuid,text,text,text,uuid,text,integer,integer)','EXECUTE')
 OR NOT has_function_privilege('vns_provider_config_writer',
    'vns.admin_authorize_sealed_provider_job_as_editor(uuid,integer,uuid,text,text,text,uuid,text,integer,integer,text,text,text)','EXECUTE')
 THEN RAISE EXCEPTION 'Unsafe sealed provider job privileges'; END IF;
END $test$;
-- A non-admin and a worker cannot persist encrypted job data directly.
DO $denied$
DECLARE forbidden boolean:=false;
BEGIN
 EXECUTE 'SET LOCAL ROLE vns_provider_usage_writer';
 BEGIN
  INSERT INTO vns.provider_named_job_sealed_prompts(
   job_id,iv_base64,tag_base64,ciphertext_base64,prompt_sha256)
  VALUES('a4600001-0000-4000-8000-000000000001',
   'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==','AAAA',repeat('a',64));
 EXCEPTION WHEN insufficient_privilege THEN forbidden:=true;
 END;
 EXECUTE 'RESET ROLE';
 IF NOT forbidden THEN RAISE EXCEPTION 'Worker could persist ciphertext'; END IF;
END $denied$;
ROLLBACK;
