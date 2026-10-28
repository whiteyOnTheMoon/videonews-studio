-- CI-only temporary PostgreSQL 17 transaction. No key bytes here
-- correspond to any real provider account or can be used to send requests.
BEGIN;
DO $permissions$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM vns.schema_migrations
   WHERE version='0043_claimed_provider_secret_scope')
 OR (SELECT count(*) FROM vns.provider_live_credential_reads)<>0
 OR has_table_privilege('vns_provider_secret_reader',
   'vns.ai_provider_sealed_credentials','SELECT')
 OR has_table_privilege('vns_provider_secret_reader',
   'vns.provider_live_credential_reads','INSERT')
 OR has_function_privilege('vns_provider_usage_writer',
   'vns.claimed_provider_sealed_key(uuid,text)','EXECUTE')
 OR has_function_privilege('vns_provider_config_writer',
   'vns.claimed_provider_sealed_key(uuid,text)','EXECUTE')
 OR has_function_privilege('vns_api_runtime',
   'vns.claimed_provider_sealed_key(uuid,text)','EXECUTE')
 OR NOT has_function_privilege('vns_provider_secret_reader',
   'vns.claimed_provider_sealed_key(uuid,text)','EXECUTE')
 OR (SELECT rolcanlogin FROM pg_roles
     WHERE rolname='vns_provider_secret_reader')
 OR (SELECT enabled FROM vns.provider_live_eur_policy)
 THEN RAISE EXCEPTION 'Unsafe secret read default/role privileges'; END IF;
END $permissions$;

INSERT INTO vns.editor_accounts
 (id,username,display_name,role,password_hash,active,auth_version)
 VALUES ('a4300001-0000-4000-8000-000000000001','ci_secret_admin',
  'CI Secret Admin','admin',
  'scrypt$'||repeat('a',32)||'$'||repeat('b',128),true,0);
INSERT INTO vns.jobs(id,kind,idempotency_key)
 VALUES ('a4300002-0000-4000-8000-000000000002','script','ci-secret-key-first'),
 ('a4300003-0000-4000-8000-000000000003','script','ci-secret-key-rotated'),
 ('a4300004-0000-4000-8000-000000000004','script','ci-secret-key-no-claim');
INSERT INTO vns.provider_live_price_snapshots(
 id,provider,model,price_version,
 input_micro_usd_per_million,cached_micro_usd_per_million,
 output_micro_usd_per_million,expires_at,source_reference,reviewed_by
) VALUES(
 'a4300005-0000-4000-8000-000000000005',
 'openai','ci_secret_model_43','ci_secret_price_0043',
 1000000,200000,2000000,clock_timestamp()+interval '1 day',
 'https://example.org/ci-secret-prices','ci_secret_admin'
);
INSERT INTO vns.provider_live_named_price_reviews(
 kind,snapshot_id,editor_id,editor_username,editor_auth_version,database_login
) VALUES(
 'model_price','a4300005-0000-4000-8000-000000000005',
 'a4300001-0000-4000-8000-000000000001','ci_secret_admin',0,session_user
);
INSERT INTO vns.provider_live_fx_snapshots(
 id,micro_eur_per_micro_usd_nanos,source_reference,reviewed_by,expires_at
) VALUES(
 'a4300006-0000-4000-8000-000000000006',1000000000,
 'https://example.org/ci-secret-fx','ci_secret_admin',
 clock_timestamp()+interval '1 hour'
);
UPDATE vns.provider_live_budget_policy
 SET enabled=true,halted=false,global_cap_micro_usd=1200,
 day_cap_micro_usd=1200,month_cap_micro_usd=1200,
 job_cap_micro_usd=600,request_cap_micro_usd=600;
UPDATE vns.provider_live_eur_policy
 SET enabled=true,global_cap_micro_eur=1200,
 active_fx_snapshot_id='a4300006-0000-4000-8000-000000000006';
-- EUR hard cap is at most 1,000,000 micro-EUR; 1,200 is synthetic.

SET LOCAL ROLE vns_provider_config_writer;
SELECT vns.admin_mutate_ai_provider_as_editor(
 'openai','set_model','ci_secret_model_43',NULL,NULL,NULL,
 'a4300001-0000-4000-8000-000000000001',0);
SELECT vns.admin_mutate_ai_provider_as_editor(
 'openai','set_key',NULL,
 decode(repeat('01',12),'hex'),decode(repeat('02',32),'hex'),
 decode(repeat('03',16),'hex'),
 'a4300001-0000-4000-8000-000000000001',0);
RESET ROLE;

SET LOCAL ROLE vns_provider_usage_writer;
SELECT vns.reserve_provider_live_budget(
 'a4300002-0000-4000-8000-000000000002','openai','ci_secret_model_43',
 'ci_secret_read_first_0043','a4300005-0000-4000-8000-000000000005',100,100);
SELECT vns.reserve_provider_live_budget(
 'a4300003-0000-4000-8000-000000000003','openai','ci_secret_model_43',
 'ci_secret_rotated_0043','a4300005-0000-4000-8000-000000000005',100,100);
SELECT vns.reserve_provider_live_budget(
 'a4300004-0000-4000-8000-000000000004','openai','ci_secret_model_43',
 'ci_secret_no_claim_0043','a4300005-0000-4000-8000-000000000005',100,100);
RESET ROLE;

DO $identities$
BEGIN
 IF (SELECT count(*) FROM vns.provider_live_reservations)<>3
 THEN RAISE EXCEPTION 'Invalid fixture reservation count'; END IF;
END $identities$;

-- A protected reader cannot retrieve an arbitrary pre-claim envelope.
DO $before_claim$
DECLARE rid uuid; blocked boolean:=false;
BEGIN
 SELECT id INTO rid FROM vns.provider_live_reservations
  WHERE job_id='a4300004-0000-4000-8000-000000000004';
 EXECUTE 'SET LOCAL ROLE vns_provider_secret_reader';
 BEGIN
   PERFORM * FROM vns.claimed_provider_sealed_key(rid,'openai');
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 EXECUTE 'RESET ROLE';
 IF NOT blocked THEN RAISE EXCEPTION 'Key read before claim succeeded'; END IF;
END $before_claim$;
DO $claims$
DECLARE rid uuid;
BEGIN
 -- Owner finds fixtures; only the SQL function runs as the usage writer.
 FOR rid IN SELECT id FROM vns.provider_live_reservations
   WHERE job_id IN ('a4300002-0000-4000-8000-000000000002',
                    'a4300003-0000-4000-8000-000000000003')
 LOOP
   EXECUTE 'SET LOCAL ROLE vns_provider_usage_writer';
   PERFORM vns.claim_provider_live_dispatch(rid);
   EXECUTE 'RESET ROLE';
 END LOOP;
END $claims$;

DO $negative$
DECLARE rid uuid; blocked boolean:=false;
BEGIN
 SELECT id INTO rid FROM vns.provider_live_reservations
  WHERE job_id='a4300002-0000-4000-8000-000000000002';
 EXECUTE 'SET LOCAL ROLE vns_provider_secret_reader';
 BEGIN
   PERFORM * FROM vns.claimed_provider_sealed_key(rid,'google_gemini');
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 EXECUTE 'RESET ROLE';
 IF NOT blocked THEN RAISE EXCEPTION 'Wrong provider decrypted'; END IF;
END $negative$;

-- Test that a single sealed envelope is returned exactly once.
DO $first$
DECLARE rid uuid; secret_record record; blocked boolean:=false;
BEGIN
 SELECT id INTO rid FROM vns.provider_live_reservations
  WHERE job_id='a4300002-0000-4000-8000-000000000002';
 EXECUTE 'SET LOCAL ROLE vns_provider_secret_reader';
 SELECT * INTO secret_record
  FROM vns.claimed_provider_sealed_key(rid,'openai');
 IF secret_record.format_version<>1 OR
   octet_length(secret_record.nonce)<>12 OR
   octet_length(secret_record.ciphertext)<>32 OR
   octet_length(secret_record.auth_tag)<>16 THEN
   RAISE EXCEPTION 'Unexpected sealed-key envelope'; END IF;
 BEGIN
   PERFORM * FROM vns.claimed_provider_sealed_key(rid,'openai');
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 EXECUTE 'RESET ROLE';
 IF NOT blocked THEN RAISE EXCEPTION 'Second credential read succeeded'; END IF;
END $first$;

DO $counts$
BEGIN
 IF (SELECT count(*) FROM vns.provider_live_credential_reads)<>1
 OR NOT EXISTS(SELECT 1 FROM vns.provider_live_credential_reads
  WHERE provider='openai' AND database_login=session_user)
 THEN RAISE EXCEPTION 'Wrong key access audit'; END IF;
END $counts$;

-- A key rotation after SQL claim blocks a different reservation's read.
SELECT pg_sleep(0.02);
SET LOCAL ROLE vns_provider_config_writer;
SELECT vns.admin_mutate_ai_provider_as_editor(
 'openai','set_key',NULL,
 decode(repeat('04',12),'hex'),decode(repeat('05',32),'hex'),
 decode(repeat('06',16),'hex'),
 'a4300001-0000-4000-8000-000000000001',0);
RESET ROLE;
DO $rotation$
DECLARE rid uuid; blocked boolean:=false;
BEGIN
 SELECT id INTO rid FROM vns.provider_live_reservations
 WHERE job_id='a4300003-0000-4000-8000-000000000003';
 EXECUTE 'SET LOCAL ROLE vns_provider_secret_reader';
 BEGIN
   PERFORM * FROM vns.claimed_provider_sealed_key(rid,'openai');
 EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
 EXECUTE 'RESET ROLE';
 IF NOT blocked THEN RAISE EXCEPTION 'Post-claim key rotation accepted'; END IF;
END $rotation$;

DO $immutable$
DECLARE denied boolean:=false;
BEGIN
 BEGIN
  DELETE FROM vns.provider_live_credential_reads;
 EXCEPTION WHEN invalid_parameter_value THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Credential access audit deletable'; END IF;
 IF (SELECT count(*) FROM vns.provider_live_credential_reads)<>1
 THEN RAISE EXCEPTION 'Negative test wrote unauthorized audit'; END IF;
END $immutable$;
ROLLBACK;
