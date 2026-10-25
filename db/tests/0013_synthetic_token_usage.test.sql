-- P1-09 CI-only test of synthetic per-job receipt behavior.
-- Run ONLY in the disposable PostgreSQL migration container.
BEGIN;

DO $checks$
DECLARE
  first_job uuid;
  second_job uuid;
  receipt_a uuid;
  receipt_b uuid;
  receipt_repeat uuid;
  usd numeric;
BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations
      WHERE version IN ('0012_runtime_least_privilege',
                        '0013_synthetic_token_usage'))<>2 THEN
    RAISE EXCEPTION 'Runtime role and token receipt migrations missing';
  END IF;

  INSERT INTO vns.jobs(kind,idempotency_key)
  VALUES ('research','ci-token-job-a') RETURNING id INTO first_job;
  INSERT INTO vns.jobs(kind,idempotency_key)
  VALUES ('render','ci-token-job-b') RETURNING id INTO second_job;

  receipt_a := vns.record_synthetic_token_usage(
    first_job, 'fixture', 'test-model-1', 'ci_request_000001',
    1000, 500, 2000000, 8000000
  );
  receipt_repeat := vns.record_synthetic_token_usage(
    first_job, 'fixture', 'test-model-1', 'ci_request_000001',
    1000, 500, 2000000, 8000000
  );
  IF receipt_a IS DISTINCT FROM receipt_repeat THEN
    RAISE EXCEPTION 'Retried synthetic receipt was duplicated';
  END IF;
  SELECT estimated_cost_micro_usd INTO usd
    FROM vns.job_token_usage WHERE id=receipt_a;
  IF usd<>6000 THEN RAISE EXCEPTION 'Token-cost calculation mismatch'; END IF;

  -- Same request ID in a different job is a distinct billable request.
  receipt_b := vns.record_synthetic_token_usage(
    second_job, 'fixture', 'test-model-1', 'ci_request_000001',
    1, 0, 1, 0
  );
  SELECT estimated_cost_micro_usd INTO usd
    FROM vns.job_token_usage WHERE id=receipt_b;
  IF usd<>1 THEN RAISE EXCEPTION 'Micro-USD ceil rounding failed'; END IF;
  IF (SELECT count(*) FROM vns.job_token_usage)<>2 THEN
    RAISE EXCEPTION 'Unexpected receipts after idempotent retry';
  END IF;

  -- Existing identity is authoritative; changed model or rate fails closed.
  BEGIN
    PERFORM vns.record_synthetic_token_usage(
      first_job, 'fixture', 'different-model', 'ci_request_000001',
      1000, 500, 2000000, 8000000);
    RAISE EXCEPTION 'Conflicting model accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM vns.record_synthetic_token_usage(
      first_job, 'fixture', 'test-model-1', 'ci_request_000001',
      1000, 500, 2000001, 8000000);
    RAISE EXCEPTION 'Conflicting rate accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM vns.record_synthetic_token_usage(
      first_job, 'fixture', 'test-model-1', 'ci_request_000001',
      1001, 500, 2000000, 8000000);
    RAISE EXCEPTION 'Conflicting usage accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  -- Neither an unrecognized job nor invalid counts may generate receipts.
  BEGIN
    PERFORM vns.record_synthetic_token_usage(
      gen_random_uuid(), 'fixture', 'test-model-1', 'ci_request_000002',
      1, 1, 1, 1);
    RAISE EXCEPTION 'Unknown job accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    PERFORM vns.record_synthetic_token_usage(
      first_job, 'fixture', 'test-model-1', 'ci_request_000003',
      -1, 1, 1, 1);
    RAISE EXCEPTION 'Negative tokens accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM vns.record_synthetic_token_usage(
      first_job, 'fixture', 'test-model-1', 'ci_request_000003',
      1, 1, -1, 1);
    RAISE EXCEPTION 'Negative price rate accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM vns.record_synthetic_token_usage(
      first_job, 'fixture', 'test-model-1', 'short',
      1, 1, 1, 1);
    RAISE EXCEPTION 'Unbounded request ID accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    INSERT INTO vns.job_token_usage(
      job_id,provider,model,request_id,input_tokens,output_tokens,
      input_micro_usd_per_million,output_micro_usd_per_million,source_type
    ) VALUES (first_job, 'fixture','test-model-1','ci_request_000004',
      1,1,1,1,'provider_reported');
    RAISE EXCEPTION 'Real-provider label accepted without approval';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- No edits or deletes of a previously acknowledged receipt.
  BEGIN
    UPDATE vns.job_token_usage SET input_tokens=2 WHERE id=receipt_a;
    RAISE EXCEPTION 'Mutable receipt accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    DELETE FROM vns.job_token_usage WHERE id=receipt_a;
    RAISE EXCEPTION 'Receipt deletion accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    TRUNCATE vns.job_token_usage;
    RAISE EXCEPTION 'Receipt truncation accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  IF (SELECT count(*) FROM vns.job_token_usage)<>2 THEN
    RAISE EXCEPTION 'Receipt contents changed after rejected mutation';
  END IF;

  -- Dormant roles, including the API and research writer, cannot access the
  -- new ledger or invoke the recording function.
  IF has_table_privilege('vns_api_runtime','vns.job_token_usage','SELECT')
     OR has_table_privilege('vns_api_runtime','vns.job_token_usage','INSERT')
     OR has_table_privilege('vns_research_writer','vns.job_token_usage','INSERT')
     OR has_table_privilege('vns_audit_reader','vns.job_token_usage','SELECT')
     OR has_function_privilege('vns_api_runtime',
          'vns.record_synthetic_token_usage(uuid,text,text,text,bigint,bigint,bigint,bigint)',
          'EXECUTE')
     OR has_function_privilege('vns_research_writer',
          'vns.record_synthetic_token_usage(uuid,text,text,text,bigint,bigint,bigint,bigint)',
          'EXECUTE')
  THEN RAISE EXCEPTION 'Unauthorized runtime access to receipts'; END IF;
END;
$checks$;

-- Actual forbidden SQL, not just metadata, must fail under a runtime role.
SET LOCAL ROLE vns_api_runtime;
DO $deny$
BEGIN
  BEGIN
    PERFORM count(*) FROM vns.job_token_usage;
    RAISE EXCEPTION 'API role read private receipt ledger';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$deny$;
RESET ROLE;

ROLLBACK;
