-- P1-09 #230: disposable PG 17 only, all fixtures rolled back.
BEGIN;
DO $defaults$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM vns.schema_migrations
   WHERE version='0041_named_live_price_fx_reviews')
 OR (SELECT count(*) FROM vns.provider_live_named_price_reviews)<>0
 OR has_table_privilege('vns_provider_config_writer',
   'vns.provider_live_price_snapshots','INSERT')
 OR has_table_privilege('vns_provider_config_writer',
   'vns.provider_live_fx_snapshots','INSERT')
 OR has_table_privilege('vns_provider_config_writer',
   'vns.provider_live_named_price_reviews','INSERT')
 OR has_function_privilege('vns_provider_config_writer',
   'vns.admin_assert_live_price_reviewer(uuid,integer)','EXECUTE')
 OR NOT has_function_privilege('vns_provider_config_writer',
   'vns.admin_review_live_provider_fx_as_editor(uuid,integer,bigint,timestamptz,text)','EXECUTE')
 OR NOT has_function_privilege('vns_provider_config_writer',
   'vns.admin_review_live_provider_price_as_editor(uuid,integer,text,text,text,bigint,bigint,bigint,timestamptz,text)','EXECUTE')
 OR has_function_privilege('vns_api_runtime',
   'vns.admin_review_live_provider_fx_as_editor(uuid,integer,bigint,timestamptz,text)','EXECUTE')
 OR has_function_privilege('vns_provider_usage_writer',
   'vns.admin_review_live_provider_price_as_editor(uuid,integer,text,text,text,bigint,bigint,bigint,timestamptz,text)','EXECUTE')
 OR has_table_privilege('vns_provider_config_writer',
   'vns.provider_live_eur_policy','UPDATE')
 OR has_table_privilege('vns_provider_config_writer',
   'vns.provider_live_budget_policy','UPDATE')
 OR (SELECT enabled FROM vns.provider_live_eur_policy)
 OR (SELECT enabled FROM vns.provider_live_budget_policy)
 THEN RAISE EXCEPTION 'Unsafe price review privileges or activation'; END IF;
END $defaults$;
INSERT INTO vns.editor_accounts(
 id,username,display_name,role,password_hash,active,auth_version
) VALUES
 ('a4100001-0000-4000-8000-000000000001','ci_price_admin',
 'CI price administrator','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true,0),
 ('a4100002-0000-4000-8000-000000000002','ci_price_editor',
 'CI price editor','editor','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true,0);

SET LOCAL ROLE vns_provider_config_writer;
DO $bad$
DECLARE denied boolean;
BEGIN
 denied:=false;
 BEGIN
  PERFORM vns.admin_review_live_provider_fx_as_editor(
   'a4100002-0000-4000-8000-000000000002',0,1150000000,
   clock_timestamp()+interval '2 hours','https://example.org/ci-fx');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Non-admin price review accepted'; END IF;

 denied:=false;
 BEGIN
  PERFORM vns.admin_review_live_provider_fx_as_editor(
   'a4100001-0000-4000-8000-000000000001',1,1150000000,
   clock_timestamp()+interval '2 hours','https://example.org/ci-fx');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Wrong auth version accepted'; END IF;

 denied:=false;
 BEGIN
  PERFORM vns.admin_review_live_provider_fx_as_editor(
   'a4100001-0000-4000-8000-000000000001',0,0,
   clock_timestamp()+interval '2 hours','https://example.org/ci-fx');
 EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Zero FX accepted'; END IF;

 denied:=false;
 BEGIN
  PERFORM vns.admin_review_live_provider_fx_as_editor(
   'a4100001-0000-4000-8000-000000000001',0,1150000000,
   clock_timestamp()+interval '3 days','https://example.org/ci-fx');
 EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Long-lived FX accepted'; END IF;

 denied:=false;
 BEGIN
  PERFORM vns.admin_review_live_provider_price_as_editor(
   'a4100001-0000-4000-8000-000000000001',0,'openai','ci-model',
   'ci_model_price_0001',1000000,2000000,3000000,
   clock_timestamp()+interval '1 day','https://example.org/ci-pricing');
 EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'More expensive cached tokens accepted'; END IF;

 denied:=false;
 BEGIN
  PERFORM vns.admin_review_live_provider_price_as_editor(
   'a4100001-0000-4000-8000-000000000001',0,'openai','ci-model',
   'ci_model_price_0001',1000000,250000,2000000,
   clock_timestamp()+interval '1 day','http://example.org/ci-pricing');
 EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Unsecured pricing reference accepted'; END IF;

 denied:=false;
 BEGIN
  INSERT INTO vns.provider_live_price_snapshots (
    provider,model,price_version,input_micro_usd_per_million,
    cached_micro_usd_per_million,output_micro_usd_per_million,
    expires_at,source_reference,reviewed_by
   ) VALUES ('openai','fake','forged_price_version',1,1,1,
    clock_timestamp()+interval '1 day','forged_source','attacker');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Writer inserted unreviewed price'; END IF;

 denied:=false;
 BEGIN
  UPDATE vns.provider_live_eur_policy SET enabled=true;
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Writer enabled spending gate'; END IF;
END $bad$;

DO $reviews$
DECLARE price_id uuid; fx_id uuid; denied boolean:=false;
BEGIN
 price_id:=vns.admin_review_live_provider_price_as_editor(
   'a4100001-0000-4000-8000-000000000001',0,'openai','ci-reviewed-model',
   'ci_reviewed_version_01',1000000,250000,2000000,
   clock_timestamp()+interval '1 day','https://example.org/ci-price-source');
 fx_id:=vns.admin_review_live_provider_fx_as_editor(
   'a4100001-0000-4000-8000-000000000001',0,1150000000,
   clock_timestamp()+interval '2 hours','https://example.org/ci-fx-source');
 IF price_id IS NULL OR fx_id IS NULL OR price_id=fx_id THEN
  RAISE EXCEPTION 'Invalid returned review identities'; END IF;
 BEGIN
  PERFORM vns.admin_review_live_provider_price_as_editor(
   'a4100001-0000-4000-8000-000000000001',0,'openai','ci-reviewed-model',
   'ci_reviewed_version_01',900000,250000,2000000,
   clock_timestamp()+interval '1 day','https://example.org/ci-price-source');
 EXCEPTION WHEN unique_violation THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Conflicting price version accepted'; END IF;
END $reviews$;
RESET ROLE;

DO $proof$
DECLARE denied boolean;
BEGIN
 IF (SELECT count(*) FROM vns.provider_live_named_price_reviews)<>2
 OR (SELECT count(*) FROM vns.provider_live_fx_snapshots)<>1
 OR (SELECT count(*) FROM vns.provider_live_price_snapshots)<>1
 OR NOT EXISTS (
  SELECT 1 FROM vns.provider_live_named_price_reviews
  WHERE kind='model_price' AND editor_username='ci_price_admin'
   AND editor_id='a4100001-0000-4000-8000-000000000001'
   AND editor_auth_version=0 AND database_login=session_user)
 OR NOT EXISTS (
  SELECT 1 FROM vns.provider_live_named_price_reviews
  WHERE kind='fx_ceiling' AND editor_username='ci_price_admin'
   AND editor_id='a4100001-0000-4000-8000-000000000001'
   AND editor_auth_version=0 AND database_login=session_user)
 OR (SELECT enabled FROM vns.provider_live_eur_policy)
 OR (SELECT enabled FROM vns.provider_live_budget_policy)
 OR EXISTS (SELECT 1 FROM vns.provider_live_dispatch_claims)
 THEN RAISE EXCEPTION 'Offline review incorrectly activated providers'; END IF;
 denied:=false;
 BEGIN
  DELETE FROM vns.provider_live_named_price_reviews;
 EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Named review deletable'; END IF;
 denied:=false;
 BEGIN
  UPDATE vns.provider_live_named_price_reviews SET editor_username='forged';
 EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Named review editable'; END IF;
END $proof$;

-- A revoked admin is not permitted to add any future price snapshots.
UPDATE vns.editor_accounts SET active=false
 WHERE id='a4100001-0000-4000-8000-000000000001';
SET LOCAL ROLE vns_provider_config_writer;
DO $revoked$
DECLARE denied boolean:=false;
BEGIN
 BEGIN
  PERFORM vns.admin_review_live_provider_fx_as_editor(
   'a4100001-0000-4000-8000-000000000001',0,1200000000,
   clock_timestamp()+interval '2 hours','https://example.org/ci-fx-source');
 EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Revoked admin accepted'; END IF;
END $revoked$;
RESET ROLE;
DO $final$
BEGIN
 IF (SELECT count(*) FROM vns.provider_live_named_price_reviews)<>2
 THEN RAISE EXCEPTION 'Failed write created review event'; END IF;
END $final$;
ROLLBACK;
