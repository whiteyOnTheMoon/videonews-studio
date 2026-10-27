-- P1-09 / #230: only disposable PostgreSQL; rolls back all fixtures.
BEGIN;
DO $defaults$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM vns.schema_migrations
     WHERE version='0037_provider_live_budget_ledger')
    OR (SELECT count(*) FROM vns.provider_live_reservations) <> 0
    OR (SELECT count(*) FROM vns.provider_live_price_snapshots) <> 0
    OR (SELECT count(*) FROM vns.provider_live_settlements) <> 0
    OR EXISTS(SELECT 1 FROM vns.provider_live_budget_policy
      WHERE enabled OR halted OR global_cap_micro_usd<>0
        OR day_cap_micro_usd<>0 OR month_cap_micro_usd<>0
        OR job_cap_micro_usd<>0 OR request_cap_micro_usd<>0)
  THEN RAISE EXCEPTION 'Live billing is not default-off'; END IF;

  IF has_table_privilege('vns_provider_usage_writer','vns.provider_live_budget_policy','UPDATE')
    OR has_table_privilege('vns_provider_usage_writer','vns.provider_live_reservations','INSERT')
    OR has_table_privilege('vns_provider_usage_writer','vns.provider_live_settlements','SELECT')
    OR has_function_privilege('vns_api_runtime',
      'vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)','EXECUTE')
    OR NOT has_function_privilege('vns_provider_usage_writer',
      'vns.reserve_provider_live_budget(uuid,text,text,text,uuid,bigint,bigint)','EXECUTE')
    OR has_function_privilege('vns_research_writer',
      'vns.settle_provider_live_budget(uuid,uuid)','EXECUTE')
    OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
       WHERE r.rolname='vns_provider_usage_writer')
  THEN RAISE EXCEPTION 'Unexpected live budget permissions'; END IF;
END;
$defaults$;
INSERT INTO vns.jobs(id,kind,idempotency_key) VALUES
 ('b3700001-1111-4111-8111-111111111111','script','ci-live-budget-A'),
 ('b3700002-2222-4222-8222-222222222222','script','ci-live-budget-B');
INSERT INTO vns.provider_live_price_snapshots(
  id,provider,model,price_version,input_micro_usd_per_million,
  cached_micro_usd_per_million,output_micro_usd_per_million,
  expires_at,source_reference,reviewed_by
) VALUES (
 'b3700000-0000-4000-8000-000000000001','openai','ci-test-model',
 'ci_reviewed_price_0001',1000000,250000,2000000,
 clock_timestamp()+INTERVAL '1 day','CI synthetic, invented prices','synthetic_ci'
),(
 'b3700000-0000-4000-8000-000000000002','openai','ci-test-model',
 'ci_expired_price_0001',1000000,250000,2000000,
 clock_timestamp()-INTERVAL '1 day','CI expired-only price','synthetic_ci'
);

-- A disabled policy must refuse admission even with a snapshot.
SET LOCAL ROLE vns_provider_usage_writer;
DO $off$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'b3700001-1111-4111-8111-111111111111','openai','ci-test-model',
      'ci_request_budget_off','b3700000-0000-4000-8000-000000000001',100,100);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Disabled default budget accepted'; END IF;
END;
$off$;
RESET ROLE;

UPDATE vns.provider_live_budget_policy SET
  enabled=true,global_cap_micro_usd=400,day_cap_micro_usd=400,
  month_cap_micro_usd=400,job_cap_micro_usd=350,request_cap_micro_usd=350;

SET LOCAL ROLE vns_provider_usage_writer;
DO $reservations$
DECLARE
  a uuid;
  a_again uuid;
  b uuid;
  receipt uuid;
  bad_receipt uuid;
  blocked boolean;
BEGIN
  blocked:=false;
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'b3700001-1111-4111-8111-111111111111','openai','ci-test-model',
      'ci_expired_price_req','b3700000-0000-4000-8000-000000000002',100,100);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Expired price was admitted'; END IF;

  a:=vns.reserve_provider_live_budget(
    'b3700001-1111-4111-8111-111111111111','openai','ci-test-model',
    'ci_live_request_0001','b3700000-0000-4000-8000-000000000001',100,100);
  a_again:=vns.reserve_provider_live_budget(
    'b3700001-1111-4111-8111-111111111111','openai','ci-test-model',
    'ci_live_request_0001','b3700000-0000-4000-8000-000000000001',100,100);
  IF a IS NULL OR a<>a_again THEN
    RAISE EXCEPTION 'Identical budget retry changed reservation ID'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'b3700001-1111-4111-8111-111111111111','openai','ci-test-model',
      'ci_live_request_0001','b3700000-0000-4000-8000-000000000001',90,100);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Conflicting retry accepted'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'b3700002-2222-4222-8222-222222222222','openai','ci-test-model',
      'ci_live_request_0002','b3700000-0000-4000-8000-000000000001',100,100);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Global/day/month cap bypassed'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.settle_provider_live_budget(a,gen_random_uuid());
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Missing provider usage accepted'; END IF;

  -- Quote 75 uncached input * 1 + 25 cached * .25 + 40 output * 2:
  -- ceil(75+6.25+80) = 162 micro-USD.
  receipt := vns.record_provider_usage_evidence(
    'b3700001-1111-4111-8111-111111111111','openai','ci-test-model',
    'ci_live_request_0001','ci_live_response_0001','ci_reviewed_price_0001',
    100,40,25,162);
  IF vns.settle_provider_live_budget(a,receipt)<>'settled'
    OR vns.settle_provider_live_budget(a,receipt)<>'settled' THEN
    RAISE EXCEPTION 'Idempotent final settlement rejected'; END IF;

  b:=vns.reserve_provider_live_budget(
    'b3700002-2222-4222-8222-222222222222','openai','ci-test-model',
    'ci_live_request_0002','b3700000-0000-4000-8000-000000000001',100,100);
  IF b IS NULL THEN RAISE EXCEPTION 'Settled exposure was not refunded'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'b3700001-1111-4111-8111-111111111111','openai','ci-test-model',
      'ci_live_request_0003','b3700000-0000-4000-8000-000000000001',100,100);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Pending USD exposure was ignored'; END IF;

  bad_receipt:=vns.record_provider_usage_evidence(
    'b3700002-2222-4222-8222-222222222222','openai','ci-test-model',
    'ci_live_request_0002','ci_live_response_0002','ci_reviewed_price_0001',
    100,40,25,999);
  IF vns.settle_provider_live_budget(b,bad_receipt)<>'halted' THEN
    RAISE EXCEPTION 'Unpriced vendor discrepancy did not halt budget'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'b3700001-1111-4111-8111-111111111111','openai','ci-test-model',
      'ci_live_request_0004','b3700000-0000-4000-8000-000000000001',1,1);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Globally halted project accepted spend'; END IF;
END;
$reservations$;
RESET ROLE;

DO $results$
DECLARE blocked boolean;
BEGIN
  IF (SELECT count(*) FROM vns.provider_live_reservations)<>2
    OR (SELECT count(*) FROM vns.provider_live_settlements)<>1
    OR (SELECT count(*) FROM vns.provider_live_budget_incidents)<>1
    OR (SELECT count(*) FROM vns.provider_usage_receipts)<>2
    OR (SELECT actual_micro_usd FROM vns.provider_live_settlements)<>162
    OR NOT (SELECT halted FROM vns.provider_live_budget_policy)
    OR (SELECT sum(a.reserved_micro_usd) FROM vns.provider_live_reservations a)<>600
  THEN RAISE EXCEPTION 'Wrong settled/pending/budget state'; END IF;
  blocked:=false;
  BEGIN
    UPDATE vns.provider_live_reservations SET reserved_micro_usd=1;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Reservation audit was mutable'; END IF;
  blocked:=false;
  BEGIN
    DELETE FROM vns.provider_live_settlements;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Settlement history was deletable'; END IF;
  blocked:=false;
  BEGIN
    UPDATE vns.provider_live_price_snapshots SET input_micro_usd_per_million=1;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Price snapshot was mutable'; END IF;
END;
$results$;
ROLLBACK;
