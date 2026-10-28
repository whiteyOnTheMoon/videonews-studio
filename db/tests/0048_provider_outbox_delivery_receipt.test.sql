-- Temporary PostgreSQL role and delivery tests, rolled back.
BEGIN;
DO $acl$
BEGIN
 IF NOT has_function_privilege('vns_provider_outbox_reader',
      'vns.read_authorized_provider_outbox(integer)','EXECUTE')
 OR NOT has_function_privilege('vns_provider_outbox_reader',
      'vns.ack_provider_outbox_delivery(uuid)','EXECUTE')
 OR has_table_privilege('vns_provider_outbox_reader',
      'vns.provider_named_job_sealed_prompts','SELECT')
 OR has_table_privilege('vns_provider_usage_writer',
      'vns.provider_named_job_delivery_receipts','INSERT')
 OR has_function_privilege('vns_provider_config_writer',
      'vns.read_authorized_provider_outbox(integer)','EXECUTE')
 THEN RAISE EXCEPTION 'Provider ciphertext producer ACL breach'; END IF;
END $acl$;

INSERT INTO vns.editor_accounts
 (id,username,display_name,role,password_hash,active,auth_version)
 VALUES('a4800001-0000-4000-8000-000000000001','ci_outbox_admin_48',
 'CI Outbox Admin','admin','scrypt$'||repeat('a',32)||'$'||repeat('b',128),true,0);
SET LOCAL ROLE vns_provider_config_writer;
SELECT vns.admin_review_live_provider_price_as_editor(
 'a4800001-0000-4000-8000-000000000001',0,
 'openai','ci_outbox_model_48','ci_outbox_version_0048',
 1000000,100000,2000000,clock_timestamp()+interval '1 day',
 'https://example.org/ci-provider-price');
SELECT vns.admin_mutate_ai_provider_as_editor(
 'openai','set_model','ci_outbox_model_48',NULL,NULL,NULL,
 'a4800001-0000-4000-8000-000000000001',0);
RESET ROLE;
DO $flow$
DECLARE price_id uuid; created uuid; result_id uuid; delivered boolean;
BEGIN
 SELECT id INTO price_id FROM vns.provider_live_price_snapshots
 WHERE provider='openai' AND model='ci_outbox_model_48';
 EXECUTE 'SET LOCAL ROLE vns_provider_config_writer';
 SELECT vns.admin_create_sealed_provider_job_as_editor(
  'a4800001-0000-4000-8000-000000000001',0,
  'ci_outbox_idempotency_key_0048',
  'ci_outbox_request_0048','openai','ci_outbox_model_48',price_id,
  repeat('a',64),100,32,
  'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA==','AAAA') INTO created;
 EXECUTE 'RESET ROLE';
 IF created IS NULL THEN RAISE EXCEPTION 'No source job'; END IF;
 EXECUTE 'SET LOCAL ROLE vns_provider_outbox_reader';
 SELECT job_id INTO result_id FROM vns.read_authorized_provider_outbox(1);
 IF result_id IS DISTINCT FROM created THEN RAISE EXCEPTION 'Read lost authorized job'; END IF;
 SELECT vns.ack_provider_outbox_delivery(created) INTO delivered;
 IF delivered IS DISTINCT FROM true THEN RAISE EXCEPTION 'Receipt not recorded'; END IF;
 SELECT vns.ack_provider_outbox_delivery(created) INTO delivered;
 IF delivered IS DISTINCT FROM true THEN RAISE EXCEPTION 'Receipt replay not idempotent'; END IF;
 SELECT job_id INTO result_id FROM vns.read_authorized_provider_outbox(1);
 IF result_id IS NOT NULL THEN RAISE EXCEPTION 'Acknowledged job reissued'; END IF;
 EXECUTE 'RESET ROLE';
 IF (SELECT count(*) FROM vns.provider_named_job_delivery_receipts WHERE job_id=created)<>1
 THEN RAISE EXCEPTION 'Receipt duplicated'; END IF;
END $flow$;
ROLLBACK;
