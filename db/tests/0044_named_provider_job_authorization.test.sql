-- Disposable PostgreSQL only: no provider transport and no budget activation.
BEGIN;
DO $permissions$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM vns.schema_migrations
   WHERE version='0044_named_provider_job_authorization')
 OR (SELECT count(*) FROM vns.provider_named_job_authorizations)<>0
 OR (SELECT count(*) FROM vns.provider_named_job_outbox)<>0
 OR has_table_privilege('vns_provider_usage_writer',
    'vns.provider_named_job_authorizations','INSERT')
 OR has_table_privilege('vns_provider_config_writer',
    'vns.provider_named_job_authorizations','INSERT')
 OR NOT has_function_privilege('vns_provider_usage_writer',
    'vns.verify_provider_named_job_authorization(uuid,text,text,text,uuid,text,integer,integer)',
    'EXECUTE')
 THEN RAISE EXCEPTION 'Provider job authorization ACL unsafe'; END IF;
END $permissions$;

INSERT INTO vns.editor_accounts
 (id,username,display_name,role,password_hash,active,auth_version)
 VALUES ('a4400001-0000-4000-8000-000000000001','ci_named_job',
 'CI Named Job','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true,0);
INSERT INTO vns.jobs(id,kind,max_attempts,idempotency_key)
 VALUES ('a4400002-0000-4000-8000-000000000002','script',1,'ci-provider-auth-44'),
 ('a4400003-0000-4000-8000-000000000003','research',1,'ci-provider-wrong-kind-44');

SET LOCAL ROLE vns_provider_config_writer;
SELECT vns.admin_review_live_provider_price_as_editor(
 'a4400001-0000-4000-8000-000000000001',0,
 'openai','ci_reviewed_44','ci_reviewed_price_0044',
 1000000,200000,2000000,clock_timestamp()+interval '1 day',
 'https://example.org/ci-provider-authority');
SELECT vns.admin_mutate_ai_provider_as_editor(
 'openai','set_model','ci_reviewed_44',NULL,NULL,NULL,
 'a4400001-0000-4000-8000-000000000001',0);
RESET ROLE;
DO $negative$
DECLARE price_id uuid; denied boolean:=false;
BEGIN
 SELECT id INTO price_id FROM vns.provider_live_price_snapshots
 WHERE provider='openai' AND model='ci_reviewed_44';
 EXECUTE 'SET LOCAL ROLE vns_provider_config_writer';
 BEGIN
 PERFORM vns.admin_authorize_provider_job_as_editor(
 'a4400001-0000-4000-8000-000000000001',0,
 'a4400003-0000-4000-8000-000000000003',
 'ci_bad_kind_request_44','openai','ci_reviewed_44',price_id,
 repeat('a',64),100,32);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 EXECUTE 'RESET ROLE';
 IF NOT denied THEN RAISE EXCEPTION 'Unauthorized job kind accepted'; END IF;
END $negative$;
DO $positive$
DECLARE price_id uuid; verified boolean;
BEGIN
 SELECT id INTO price_id FROM vns.provider_live_price_snapshots
 WHERE provider='openai' AND model='ci_reviewed_44';
 EXECUTE 'SET LOCAL ROLE vns_provider_config_writer';
 PERFORM vns.admin_authorize_provider_job_as_editor(
 'a4400001-0000-4000-8000-000000000001',0,
 'a4400002-0000-4000-8000-000000000002',
 'ci_valid_request_0044','openai','ci_reviewed_44',price_id,
 repeat('a',64),100,32);
 EXECUTE 'RESET ROLE';
 EXECUTE 'SET LOCAL ROLE vns_provider_usage_writer';
 SELECT vns.verify_provider_named_job_authorization(
 'a4400002-0000-4000-8000-000000000002',
 'ci_valid_request_0044','openai','ci_reviewed_44',price_id,
 repeat('a',64),100,32) INTO verified;
 IF verified IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Valid authorization unavailable'; END IF;
 SELECT vns.verify_provider_named_job_authorization(
 'a4400002-0000-4000-8000-000000000002',
 'ci_valid_request_0044','openai','ci_reviewed_44',price_id,
 repeat('b',64),100,32) INTO verified;
 EXECUTE 'RESET ROLE';
 IF verified IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'Changed prompt digest authorized'; END IF;
END $positive$;
UPDATE vns.editor_accounts SET auth_version=1
 WHERE id='a4400001-0000-4000-8000-000000000001';
DO $revoked$
DECLARE price_id uuid; verified boolean;
BEGIN
 SELECT price_snapshot_id INTO price_id FROM vns.provider_named_job_authorizations
 WHERE job_id='a4400002-0000-4000-8000-000000000002';
 EXECUTE 'SET LOCAL ROLE vns_provider_usage_writer';
 SELECT vns.verify_provider_named_job_authorization(
 'a4400002-0000-4000-8000-000000000002',
 'ci_valid_request_0044','openai','ci_reviewed_44',price_id,
 repeat('a',64),100,32) INTO verified;
 EXECUTE 'RESET ROLE';
 IF verified IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'Revoked identity authorized'; END IF;
END $revoked$;
ROLLBACK;
