-- 0038: offline PostgreSQL guard; disposable fixture rolls back.
BEGIN;
DO $acl$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vns.schema_migrations
    WHERE version='0038_provider_worker_budget_guard')
    OR (SELECT count(*) FROM vns.provider_live_worker_faults)<>0
    OR (SELECT enabled FROM vns.provider_live_budget_policy)
    OR has_table_privilege('vns_provider_usage_writer',
      'vns.provider_live_worker_faults','INSERT')
    OR has_table_privilege('vns_provider_usage_writer',
      'vns.provider_live_reservations','SELECT')
    OR has_function_privilege('vns_api_runtime',
      'vns.halt_provider_live_budget(uuid,text)','EXECUTE')
    OR NOT has_function_privilege('vns_provider_usage_writer',
      'vns.halt_provider_live_budget(uuid,text)','EXECUTE')
    OR NOT has_function_privilege('vns_provider_usage_writer',
      'vns.get_provider_live_reservation(uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'Unsafe 0038 baseline'; END IF;
END $acl$;

INSERT INTO vns.jobs(id,kind,idempotency_key)
VALUES('a3800001-1111-4111-8111-111111111111','script','ci-guarded-replay-job');
INSERT INTO vns.provider_live_price_snapshots(
 id,provider,model,price_version,input_micro_usd_per_million,
 cached_micro_usd_per_million,output_micro_usd_per_million,
 expires_at,source_reference,reviewed_by
) VALUES(
 'a3800000-0000-4000-8000-000000000001','openai','ci-guarded-model',
 'ci_guarded_price_0001',1000000,250000,2000000,
 clock_timestamp()+INTERVAL '1 day','CI invented usage-only rates','synthetic_ci'
);
UPDATE vns.provider_live_budget_policy SET enabled=true,
 global_cap_micro_usd=1000,day_cap_micro_usd=1000,
 month_cap_micro_usd=1000,job_cap_micro_usd=1000,request_cap_micro_usd=1000;

SET LOCAL ROLE vns_provider_usage_writer;
DO $checks$
DECLARE
  id uuid;
  found record;
  blocked boolean;
BEGIN
  id:=vns.reserve_provider_live_budget(
    'a3800001-1111-4111-8111-111111111111','openai','ci-guarded-model',
    'ci_guarded_request_001','a3800000-0000-4000-8000-000000000001',100,100);

  SELECT * INTO STRICT found FROM vns.get_provider_live_reservation(id);
  IF found.reservation_id <> id
    OR found.job_id <> 'a3800001-1111-4111-8111-111111111111'::uuid
    OR found.request_id <> 'ci_guarded_request_001'
    OR found.provider <> 'openai' OR found.model <> 'ci-guarded-model'
    OR found.price_version <> 'ci_guarded_price_0001'
    OR found.currency <> 'USD' OR found.reserved_micro_usd <> 300
    OR found.max_input_tokens <> 100 OR found.max_output_tokens <> 100
    OR found.input_micro_usd_per_million <> 1000000
    OR found.cached_input_micro_usd_per_million <> 250000
    OR found.output_micro_usd_per_million <> 2000000
  THEN RAISE EXCEPTION 'SQL-owned reservation projection incorrect'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.get_provider_live_reservation(gen_random_uuid());
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Unknown reservation was projected'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.halt_provider_live_budget(id,'not_an_approved_reason');
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Unknown fault reason accepted'; END IF;

  IF NOT vns.halt_provider_live_budget(id,'response_missing')
    OR NOT vns.halt_provider_live_budget(id,'response_missing') THEN
    RAISE EXCEPTION 'Halt was not idempotent'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'a3800001-1111-4111-8111-111111111111','openai','ci-guarded-model',
      'ci_guarded_request_002','a3800000-0000-4000-8000-000000000001',100,100);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Halted SQL budget admitted new request'; END IF;
END $checks$;
RESET ROLE;
DO $immutable$
DECLARE blocked boolean:=false;
BEGIN
  IF (SELECT count(*) FROM vns.provider_live_worker_faults)<>1
    OR NOT (SELECT halted FROM vns.provider_live_budget_policy)
  THEN RAISE EXCEPTION 'Fault did not persist'; END IF;
  BEGIN
    DELETE FROM vns.provider_live_worker_faults;
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Fault was deletable'; END IF;
END $immutable$;
ROLLBACK;
