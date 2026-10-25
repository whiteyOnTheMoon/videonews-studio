-- CI-only synthetic reservations test. Everything rolls back.
BEGIN;
DO $ci$
DECLARE
  first_job uuid;
  second_job uuid;
  another_job uuid;
  first_id uuid;
  repeated_id uuid;
  amount bigint;
  counted bigint;
  blocked boolean;
  n integer;
  daily_job uuid;
BEGIN
  IF (SELECT count(*) FROM vns.schema_migrations
      WHERE version IN ('0013_synthetic_token_usage',
                        '0014_synthetic_ai_budget_reservations')) <> 2 THEN
    RAISE EXCEPTION 'Synthetic ledger migration not installed';
  END IF;
  INSERT INTO vns.jobs(kind,idempotency_key)
    VALUES('script','ci-reservation-job-a') RETURNING id INTO first_job;
  INSERT INTO vns.jobs(kind,idempotency_key)
    VALUES('script','ci-reservation-job-b') RETURNING id INTO second_job;

  first_id := vns.reserve_synthetic_ai_budget(
    first_job,'ci_budget_request_000001','script_draft','gpt-6.1-sol',
    20000,5000,DATE '2026-10-25');
  repeated_id := vns.reserve_synthetic_ai_budget(
    first_job,'ci_budget_request_000001','script_draft','gpt-6.1-sol',
    20000,5000,DATE '2026-10-25');
  IF first_id IS NULL OR first_id IS DISTINCT FROM repeated_id THEN
    RAISE EXCEPTION 'Reservation retry duplicated a receipt';
  END IF;
  SELECT reserved_micro_usd INTO amount FROM vns.synthetic_ai_reservations
    WHERE id=first_id;
  SELECT reserved_micro_usd INTO counted FROM vns.synthetic_ai_budget_days
    WHERE budget_day=DATE '2026-10-25';
  IF amount<>90000 OR counted<>90000 THEN
    RAISE EXCEPTION 'Offline reserve estimate or count incorrect';
  END IF;

  -- Different job may use the same request identifier.
  PERFORM vns.reserve_synthetic_ai_budget(
    second_job,'ci_budget_request_000001','script_draft','gpt-6.1-sol',
    20000,5000,DATE '2026-10-25');
  SELECT reserved_micro_usd INTO counted FROM vns.synthetic_ai_budget_days
    WHERE budget_day=DATE '2026-10-25';
  IF counted<>180000 THEN RAISE EXCEPTION 'Shared daily counter incorrect'; END IF;

  -- A changed retry must fail; its first reservation remains authoritative.
  blocked := false;
  BEGIN
    PERFORM vns.reserve_synthetic_ai_budget(
      first_job,'ci_budget_request_000001','script_draft','gpt-6.1-sol',
      19999,5000,DATE '2026-10-25');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Conflicting amount accepted'; END IF;

  blocked := false;
  BEGIN
    PERFORM vns.reserve_synthetic_ai_budget(
      first_job,'ci_budget_request_000001','script_draft','gpt-6.1-sol',
      20000,5000,DATE '2026-10-26');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Cross-day duplicate request accepted'; END IF;

  -- Per-job guard stops another full-price request after two reservations.
  PERFORM vns.reserve_synthetic_ai_budget(
    first_job,'ci_budget_request_000002','script_draft','gpt-6.1-sol',
    20000,5000,DATE '2026-10-25');
  blocked := false;
  BEGIN
    PERFORM vns.reserve_synthetic_ai_budget(
      first_job,'ci_budget_request_000003','script_draft','gpt-6.1-sol',
      20000,5000,DATE '2026-10-25');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Per-job cap not enforced'; END IF;

  -- Model and stage or token ceiling errors cannot reserve funds.
  blocked := false;
  BEGIN
    PERFORM vns.reserve_synthetic_ai_budget(
      second_job,'ci_budget_request_000004','topic_triage','gpt-6.1-sol',
      4000,700,DATE '2026-10-25');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Incorrect stage model accepted'; END IF;
  blocked := false;
  BEGIN
    PERFORM vns.reserve_synthetic_ai_budget(
      second_job,'ci_budget_request_000005','script_draft','gpt-6.1-sol',
      20001,5000,DATE '2026-10-25');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Overlong context accepted'; END IF;
  blocked := false;
  BEGIN
    PERFORM vns.reserve_synthetic_ai_budget(
      second_job,'ci_budget_request_000006','script_draft','gpt-6.1-sol',
      1,0,DATE '2026-10-25');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Zero max output accepted'; END IF;
  blocked := false;
  BEGIN
    PERFORM vns.reserve_synthetic_ai_budget(
      gen_random_uuid(),'ci_budget_request_000007','topic_triage','gpt-6-luna',
      1000,100,DATE '2026-10-25');
  EXCEPTION WHEN foreign_key_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Unknown job accepted'; END IF;

  -- Test cumulative daily cap on a separate synthetic date. Each fresh
  -- job avoids the per-job ceiling while the daily counter grows.
  FOR n IN 1..22 LOOP
    INSERT INTO vns.jobs(kind,idempotency_key)
      VALUES('script','ci-budget-day-job-'||n) RETURNING id INTO daily_job;
    PERFORM vns.reserve_synthetic_ai_budget(
      daily_job,'ci_budget_capacity_000001','script_draft','gpt-6.1-sol',
      20000,5000,DATE '2026-10-27');
  END LOOP;
  SELECT reserved_micro_usd INTO counted FROM vns.synthetic_ai_budget_days
    WHERE budget_day=DATE '2026-10-27';
  IF counted<>1980000 THEN RAISE EXCEPTION 'Daily cap fixture invalid'; END IF;
  INSERT INTO vns.jobs(kind,idempotency_key)
    VALUES('script','ci-budget-day-overflow') RETURNING id INTO another_job;
  blocked := false;
  BEGIN
    PERFORM vns.reserve_synthetic_ai_budget(
      another_job,'ci_budget_capacity_000002','script_draft','gpt-6.1-sol',
      20000,5000,DATE '2026-10-27');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Daily cap overflow accepted'; END IF;
  SELECT reserved_micro_usd INTO counted FROM vns.synthetic_ai_budget_days
    WHERE budget_day=DATE '2026-10-27';
  IF counted<>1980000 THEN RAISE EXCEPTION 'Failed request leaked budget'; END IF;

  -- Reservation history is append-only; counter rows cannot be deleted.
  blocked := false;
  BEGIN
    UPDATE vns.synthetic_ai_reservations
    SET state='reserved' WHERE id=first_id;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Reservation mutation accepted'; END IF;
  blocked := false;
  BEGIN
    DELETE FROM vns.synthetic_ai_reservations WHERE id=first_id;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Reservation delete accepted'; END IF;
  blocked := false;
  BEGIN
    TRUNCATE vns.synthetic_ai_reservations;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Reservation truncate accepted'; END IF;
  blocked := false;
  BEGIN
    DELETE FROM vns.synthetic_ai_budget_days WHERE budget_day=DATE '2026-10-25';
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'Budget day delete accepted'; END IF;

  -- Neither existing runtime roles nor PUBLIC can reserve/spend.
  IF has_table_privilege('vns_api_runtime','vns.synthetic_ai_reservations','SELECT')
     OR has_table_privilege('vns_research_writer','vns.synthetic_ai_reservations','INSERT')
     OR has_table_privilege('vns_audit_reader','vns.synthetic_ai_budget_days','SELECT')
     OR has_function_privilege('vns_api_runtime',
       'vns.reserve_synthetic_ai_budget(uuid,text,text,text,integer,integer,date)',
       'EXECUTE')
     OR has_function_privilege('vns_research_writer',
       'vns.reserve_synthetic_ai_budget(uuid,text,text,text,integer,integer,date)',
       'EXECUTE')
  THEN RAISE EXCEPTION 'Running role gained synthetic budget privileges'; END IF;
END;
$ci$;

SET LOCAL ROLE vns_api_runtime;
DO $deny$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    PERFORM 1 FROM vns.synthetic_ai_reservations;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Runtime API read reservation history'; END IF;
END;
$deny$;
RESET ROLE;
ROLLBACK;
