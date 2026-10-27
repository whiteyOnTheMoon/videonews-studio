-- 0036: actual-usage evidence is separate from synthetic estimates.
-- Disposable PostgreSQL CI only; entire fixture transaction is rolled back.
BEGIN;
DO $acl$
BEGIN
  IF NOT EXISTS (
      SELECT 1 FROM vns.schema_migrations
       WHERE version='0036_provider_usage_evidence'
  ) OR (SELECT count(*) FROM vns.provider_usage_receipts)<>0 THEN
    RAISE EXCEPTION 'Provider evidence migration missing or seeded';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname IN ('vns_provider_usage_writer','vns_provider_usage_executor')
       AND (rolcanlogin OR rolsuper OR rolcreaterole)
  ) OR EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
     WHERE r.rolname IN ('vns_provider_usage_writer','vns_provider_usage_executor')
  ) THEN RAISE EXCEPTION 'Unsafe provider usage role'; END IF;
  IF has_table_privilege('vns_provider_usage_writer','vns.provider_usage_receipts','INSERT')
    OR has_table_privilege('vns_provider_usage_writer','vns.provider_usage_receipts','SELECT')
    OR has_table_privilege('vns_api_runtime','vns.provider_usage_receipts','SELECT')
    OR has_table_privilege('vns_research_writer','vns.provider_usage_receipts','INSERT')
    OR has_function_privilege('vns_api_runtime',
      'vns.record_provider_usage_evidence(uuid,text,text,text,text,text,bigint,bigint,bigint,bigint)',
      'EXECUTE')
    OR NOT has_function_privilege('vns_provider_usage_writer',
      'vns.record_provider_usage_evidence(uuid,text,text,text,text,text,bigint,bigint,bigint,bigint)',
      'EXECUTE')
  THEN RAISE EXCEPTION 'Provider metering ACL leak'; END IF;
END;
$acl$;

INSERT INTO vns.jobs(id,kind,idempotency_key) VALUES
 ('ecbe0001-1111-4111-8111-111111111111','script','ci-usage-receipt-001'),
 ('ecbe0002-2222-4222-8222-222222222222','script','ci-usage-receipt-002');

SET LOCAL ROLE vns_provider_usage_writer;
DO $writes$
DECLARE
  first_id uuid;
  repeat_id uuid;
  blocked boolean;
BEGIN
  first_id := vns.record_provider_usage_evidence(
    'ecbe0001-1111-4111-8111-111111111111','openai','test-model',
    'usage_request_00001','usage_response_00001','test_price_v0001',100,40,25,250);
  repeat_id := vns.record_provider_usage_evidence(
    'ecbe0001-1111-4111-8111-111111111111','openai','test-model',
    'usage_request_00001','usage_response_00001','test_price_v0001',100,40,25,250);
  IF first_id IS NULL OR repeat_id<>first_id THEN
    RAISE EXCEPTION 'Identical provider receipt replay duplicated';
  END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.record_provider_usage_evidence(
      'ecbe0001-1111-4111-8111-111111111111','openai','test-model',
      'usage_request_00001','usage_response_00001','test_price_v0001',100,40,25,251);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Changed cost replay accepted'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.record_provider_usage_evidence(
      'ecbe0002-2222-4222-8222-222222222222','openai','test-model',
      'usage_request_00002','usage_response_00001','test_price_v0001',100,40,25,250);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Cross-job duplicated response accepted'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.record_provider_usage_evidence(
      'ecbe0001-1111-4111-8111-111111111111','openai','test-model',
      'usage_request_00003','usage_response_00003','test_price_v0001',100,40,101,250);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Cache tokens exceeded input tokens'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.record_provider_usage_evidence(
      'ecbe0001-1111-4111-8111-111111111111','google_gemini','test-model',
      'usage_request_00004','usage_response_00004','test_price_v0001',100,40,20,NULL);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Unpriced response accepted'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.record_provider_usage_evidence(
      'ecbe0001-1111-4111-8111-111111111111','openai','test-model',
      'usage_request_00005','usage_response_00005','test_price_v0001',100,40,20,-1);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Negative provider cost accepted'; END IF;

  blocked:=false;
  BEGIN
    PERFORM count(*) FROM vns.provider_usage_receipts;
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Writer could read raw receipt table'; END IF;

  blocked:=false;
  BEGIN
    UPDATE vns.provider_usage_receipts SET calculated_cost_micro_usd=0;
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Writer could edit receipt'; END IF;
END;
$writes$;
RESET ROLE;

DO $final$
DECLARE blocked boolean;
BEGIN
  IF (SELECT count(*) FROM vns.provider_usage_receipts)<>1
    OR (SELECT count(*) FROM vns.job_token_usage)<>0
    OR (SELECT count(*) FROM vns.synthetic_ai_reservations)<>0
    OR EXISTS (SELECT 1 FROM vns.provider_usage_receipts
      WHERE reconciled OR measurement_source<>'provider_response' OR currency<>'USD')
  THEN RAISE EXCEPTION 'Provider receipts mixed with synthetic or payment data'; END IF;
  blocked:=false;
  BEGIN
    DELETE FROM vns.provider_usage_receipts;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Evidence was deleted'; END IF;
  blocked:=false;
  BEGIN
    TRUNCATE vns.provider_usage_receipts;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Evidence could be truncated'; END IF;
END;
$final$;
ROLLBACK;
