-- PostgreSQL 17 disposable integration only; all data rolled back.
BEGIN;
DO $acl$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM vns.schema_migrations
    WHERE version='0039_provider_one_shot_dispatch_claim')
    OR (SELECT count(*) FROM vns.provider_live_dispatch_claims)<>0
    OR (SELECT enabled FROM vns.provider_live_budget_policy)
    OR has_table_privilege('vns_provider_usage_writer',
      'vns.provider_live_dispatch_claims','INSERT')
    OR has_table_privilege('vns_provider_usage_writer',
      'vns.provider_live_dispatch_claims','SELECT')
    OR has_function_privilege('vns_api_runtime',
      'vns.claim_provider_live_dispatch(uuid)','EXECUTE')
    OR has_function_privilege('vns_research_writer',
      'vns.claim_provider_live_dispatch(uuid)','EXECUTE')
    OR NOT has_function_privilege('vns_provider_usage_writer',
      'vns.claim_provider_live_dispatch(uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'Unsafe provider dispatch claim grants'; END IF;
END $acl$;
INSERT INTO vns.jobs(id,kind,idempotency_key) VALUES
 ('a3900001-0000-4000-8000-000000000001','script','ci-one-shot-claim-job');
INSERT INTO vns.provider_live_price_snapshots (
  id,provider,model,price_version,input_micro_usd_per_million,
  cached_micro_usd_per_million,output_micro_usd_per_million,
  expires_at,source_reference,reviewed_by
) VALUES(
 'a3900002-0000-4000-8000-000000000002','openai','ci-one-shot-model',
 'ci_one_shot_version_01',1000000,250000,2000000,
 clock_timestamp()+INTERVAL '1 day',
 'CI synthetic text price source','synthetic_ci'
),(
 'a3900003-0000-4000-8000-000000000003','openai','ci-one-shot-model',
 'ci_one_shot_expired_01',1000000,250000,2000000,
 clock_timestamp()-INTERVAL '1 day',
 'CI synthetic expired source','synthetic_ci'
);
SET LOCAL ROLE vns_provider_usage_writer;
DO $default_off$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.claim_provider_live_dispatch(
      'a3900001-0000-4000-8000-000000000001');
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Default-off claim succeeded'; END IF;
END $default_off$;
RESET ROLE;
UPDATE vns.provider_live_budget_policy SET enabled=true,
 global_cap_micro_usd=1000,day_cap_micro_usd=1000,
 month_cap_micro_usd=1000,job_cap_micro_usd=1000,request_cap_micro_usd=1000;
SET LOCAL ROLE vns_provider_usage_writer;
DO $one_shot$
DECLARE
  res uuid;
  claim_one uuid;
  claim_again uuid;
  blocked boolean;
  receipt uuid;
BEGIN
  blocked:=false;
  BEGIN
    PERFORM vns.claim_provider_live_dispatch(
      'a3900004-0000-4000-8000-000000000004');
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Unreserved request was claimed'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'a3900001-0000-4000-8000-000000000001','openai','ci-one-shot-model',
      'ci_expired_claim_0001',
      'a3900003-0000-4000-8000-000000000003',100,100);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Expired model price admitted'; END IF;

  res:=vns.reserve_provider_live_budget(
    'a3900001-0000-4000-8000-000000000001','openai','ci-one-shot-model',
    'ci_one_shot_request_0001',
    'a3900002-0000-4000-8000-000000000002',100,100);

  claim_one:=vns.claim_provider_live_dispatch(res);
  claim_again:=vns.claim_provider_live_dispatch(res);
  IF claim_one IS NULL OR claim_again IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate dispatch claim accepted'; END IF;

  receipt:=vns.record_provider_usage_evidence(
    'a3900001-0000-4000-8000-000000000001','openai','ci-one-shot-model',
    'ci_one_shot_request_0001','ci_one_shot_response_0001',
    'ci_one_shot_version_01',100,40,25,162);
  IF vns.settle_provider_live_budget(res,receipt)<>'settled' THEN
    RAISE EXCEPTION 'Claimed response settlement failed'; END IF;

  blocked:=false;
  BEGIN
    PERFORM vns.claim_provider_live_dispatch(
      'a3900004-0000-4000-8000-000000000004');
  EXCEPTION WHEN SQLSTATE '55000' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Missing reservation accepted'; END IF;
  blocked:=false;
  BEGIN
    UPDATE vns.provider_live_dispatch_claims SET claimed_at=clock_timestamp();
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Writer may edit dispatch claim'; END IF;
END $one_shot$;
RESET ROLE;
DO $proof$
DECLARE denied boolean:=false;
BEGIN
 IF (SELECT count(*) FROM vns.provider_live_dispatch_claims)<>1
   OR (SELECT count(*) FROM vns.provider_live_settlements)<>1
 THEN RAISE EXCEPTION 'Dispatch uniqueness and settlement mismatch'; END IF;
 BEGIN
   DELETE FROM vns.provider_live_dispatch_claims;
 EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
 IF NOT denied THEN RAISE EXCEPTION 'Dispatch claim deletable'; END IF;
END $proof$;
ROLLBACK;
