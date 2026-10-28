-- Disposable PostgreSQL CI: reviewed dynamic models, personal provenance,
-- stale/revoked reviewer and wrong-provider negatives. No billable requests.
BEGIN;
DO $initial$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM vns.schema_migrations
     WHERE version='0042_provider_reviewed_model_selection')
 OR EXISTS(SELECT 1 FROM vns.ai_provider_settings WHERE enabled)
 OR (SELECT count(*) FROM vns.provider_live_named_price_reviews)<>0
 OR has_table_privilege('vns_provider_config_writer',
     'vns.provider_live_named_price_reviews','SELECT')
 OR has_table_privilege('vns_provider_config_writer',
     'vns.provider_live_price_snapshots','INSERT')
 OR has_table_privilege('vns_provider_config_writer',
     'vns.ai_provider_settings','UPDATE')
 THEN RAISE EXCEPTION 'Unsafe dynamic selection privileges/defaults'; END IF;
END $initial$;
INSERT INTO vns.editor_accounts
 (id,username,display_name,role,password_hash,active,auth_version)
VALUES
 ('a4200001-0000-4000-8000-000000000001',
  'ci_model_admin','CI Model Admin','admin',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true,0);
SET LOCAL ROLE vns_provider_config_writer;
DO $pre$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
   PERFORM vns.admin_mutate_ai_provider_as_editor(
    'openai','set_model','gpt-6-luna',NULL,NULL,NULL,
    'a4200001-0000-4000-8000-000000000001',0);
 EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'Unreviewed legacy model selectable'; END IF;
 blocked:=false;
 BEGIN
   PERFORM vns.admin_mutate_ai_provider_as_editor(
    'openai','set_model','ci_dynamic_model_42',NULL,NULL,NULL,
    'a4200001-0000-4000-8000-000000000001',0);
 EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'Unknown dynamic model selectable'; END IF;
END $pre$;
RESET ROLE;

SET LOCAL ROLE vns_provider_config_writer;
DO $review$
DECLARE a uuid; b uuid; blocked boolean;
BEGIN
 a:=vns.admin_review_live_provider_price_as_editor(
   'a4200001-0000-4000-8000-000000000001',0,
   'openai','ci_dynamic_model_42','ci_dynamic_price_0042',
   2000000,500000,4000000,clock_timestamp()+interval '1 day',
   'https://example.org/ci-reviewed-model');
 b:=vns.admin_review_live_provider_price_as_editor(
   'a4200001-0000-4000-8000-000000000001',0,
   'google_gemini','ci_google_model_42','ci_google_price_0042',
   2000000,500000,4000000,clock_timestamp()+interval '1 day',
   'https://example.org/ci-reviewed-model');
 IF a IS NULL OR b IS NULL THEN RAISE EXCEPTION 'No named review'; END IF;
 PERFORM vns.admin_mutate_ai_provider_as_editor(
   'openai','set_model','ci_dynamic_model_42',NULL,NULL,NULL,
   'a4200001-0000-4000-8000-000000000001',0);

 -- The other provider has its OWN reviewed model, and cannot be
 -- selected under openai despite both being syntactically valid.
 blocked:=false;
 BEGIN
  PERFORM vns.admin_mutate_ai_provider_as_editor(
   'openai','set_model','ci_google_model_42',NULL,NULL,NULL,
   'a4200001-0000-4000-8000-000000000001',0);
 EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'Wrong-provider model selected'; END IF;
END $review$;
RESET ROLE;

-- Unreviewed direct price rows must never grant model selection.
INSERT INTO vns.provider_live_price_snapshots
(provider,model,price_version,input_micro_usd_per_million,
 cached_micro_usd_per_million,output_micro_usd_per_million,
 expires_at,source_reference,reviewed_by)
VALUES('openai','ci_unreviewed_42','ci_unreviewed_0042',
       1000,500,2000,clock_timestamp()+interval '1 day',
       'https://example.org/ci-unreviewed','ci_fake_admin');

-- Fully reviewed but expired is also rejected. CI owner only.
WITH price AS (
 INSERT INTO vns.provider_live_price_snapshots
(provider,model,price_version,input_micro_usd_per_million,
 cached_micro_usd_per_million,output_micro_usd_per_million,
 expires_at,source_reference,reviewed_by)
VALUES('openai','ci_expired_42','ci_expired_price_42',
       1000,500,2000,clock_timestamp()-interval '1 day',
       'https://example.org/ci-expired','ci_model_admin')
 RETURNING id
)
INSERT INTO vns.provider_live_named_price_reviews
(kind,snapshot_id,editor_id,editor_username,editor_auth_version,database_login)
SELECT 'model_price',price.id,
 'a4200001-0000-4000-8000-000000000001','ci_model_admin',0,session_user
FROM price;

SET LOCAL ROLE vns_provider_config_writer;
DO $deny$
DECLARE candidate text; blocked boolean;
BEGIN
 FOREACH candidate IN ARRAY ARRAY[
    'ci_unreviewed_42','ci_expired_42','https://evil.invalid',
    'ci_dynamic_model_42;DELETE',''
 ] LOOP
   blocked:=false;
   BEGIN
     PERFORM vns.admin_mutate_ai_provider_as_editor(
       'openai','set_model',candidate,NULL,NULL,NULL,
       'a4200001-0000-4000-8000-000000000001',0);
   EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;
   END;
   IF NOT blocked THEN RAISE EXCEPTION 'Untrusted model admitted: %',candidate; END IF;
 END LOOP;
END $deny$;
RESET ROLE;

UPDATE vns.editor_accounts SET active=false
 WHERE id='a4200001-0000-4000-8000-000000000001';
SET LOCAL ROLE vns_provider_config_writer;
DO $revoked$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
   PERFORM vns.admin_mutate_ai_provider_as_editor(
     'openai','set_model','ci_dynamic_model_42',NULL,NULL,NULL,
     'a4200001-0000-4000-8000-000000000001',0);
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'Revoked actor could select model'; END IF;
END $revoked$;
RESET ROLE;
DO $final$
BEGIN
 IF (SELECT selected_model FROM vns.ai_provider_settings
      WHERE provider='openai')<>'ci_dynamic_model_42'
 OR (SELECT count(*) FROM vns.ai_provider_named_config_events)<>1
 OR EXISTS(SELECT 1 FROM vns.ai_provider_settings WHERE enabled)
 OR (SELECT count(*) FROM vns.ai_provider_sealed_credentials)<>0
 OR (SELECT count(*) FROM vns.provider_live_dispatch_claims)<>0
 THEN RAISE EXCEPTION 'Dynamic model selection changed wrong system state'; END IF;
END $final$;
ROLLBACK;
