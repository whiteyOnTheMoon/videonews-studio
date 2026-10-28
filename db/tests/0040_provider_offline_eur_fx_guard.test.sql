-- Disposable PostgreSQL 17 only. Synthetic FX and prices; never a live approval.
BEGIN;
DO $default$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vns.schema_migrations
    WHERE version='0040_provider_offline_eur_fx_guard')
    OR (SELECT count(*) FROM vns.provider_live_fx_snapshots) <> 0
    OR (SELECT count(*) FROM vns.provider_live_eur_admissions) <> 0
    OR EXISTS (SELECT 1 FROM vns.provider_live_eur_policy
      WHERE enabled OR global_cap_micro_eur <> 0 OR active_fx_snapshot_id IS NOT NULL)
    OR has_table_privilege('vns_provider_usage_writer',
      'vns.provider_live_eur_policy','UPDATE')
    OR has_table_privilege('vns_provider_usage_writer',
      'vns.provider_live_eur_admissions','INSERT')
    OR has_table_privilege('vns_provider_usage_writer',
      'vns.provider_live_fx_snapshots','INSERT')
    OR has_function_privilege('vns_provider_usage_writer',
      'vns.guard_live_provider_eur_dispatch()','EXECUTE')
    OR has_function_privilege('vns_api_runtime',
      'vns.guard_live_provider_eur_reservation()','EXECUTE')
  THEN RAISE EXCEPTION 'EUR FX budget default/ACL unsafe'; END IF;
END $default$;

INSERT INTO vns.jobs(id,kind,idempotency_key) VALUES
 ('a4000001-0000-4000-8000-000000000001','script','ci-eur-guard-one'),
 ('a4000002-0000-4000-8000-000000000002','script','ci-eur-guard-two'),
 ('a4000003-0000-4000-8000-000000000003','script','ci-eur-guard-three');
INSERT INTO vns.provider_live_price_snapshots (
 id,provider,model,price_version,input_micro_usd_per_million,
 cached_micro_usd_per_million,output_micro_usd_per_million,
 expires_at,source_reference,reviewed_by
) VALUES (
 'a4000000-0000-4000-8000-000000000001','openai','ci-eur-model',
 'ci_eur_price_0001',1000000,250000,2000000,
 clock_timestamp()+interval '1 day',
 'CI synthetic model quote','synthetic_ci'
);
INSERT INTO vns.provider_live_fx_snapshots (
 id,micro_eur_per_micro_usd_nanos,reviewed_at,expires_at,
 source_reference,reviewed_by
) VALUES
 ('a4000000-0000-4000-8000-000000000002',1000000000,
  clock_timestamp(),clock_timestamp()+interval '1 hour',
  'CI synthetic conservative FX','synthetic_ci'),
 ('a4000000-0000-4000-8000-000000000003',1100000000,
  clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',
  'CI expired FX-only quote','synthetic_ci'),
 ('a4000000-0000-4000-8000-000000000004',900000000,
  clock_timestamp(),clock_timestamp()+interval '1 hour',
  'CI synthetic lower FX rotation','synthetic_ci');
UPDATE vns.provider_live_budget_policy
 SET enabled=true,global_cap_micro_usd=5000,day_cap_micro_usd=5000,
 month_cap_micro_usd=5000,job_cap_micro_usd=5000,request_cap_micro_usd=5000;

SET LOCAL ROLE vns_provider_usage_writer;
DO $off$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'a4000001-0000-4000-8000-000000000001','openai','ci-eur-model',
      'ci_eur_off_request_001','a4000000-0000-4000-8000-000000000001',
      100,100);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Disabled EUR cap admitted spending'; END IF;
END $off$;
RESET ROLE;

UPDATE vns.provider_live_eur_policy SET
 enabled=true,global_cap_micro_eur=600,
 active_fx_snapshot_id='a4000000-0000-4000-8000-000000000003';
SET LOCAL ROLE vns_provider_usage_writer;
DO $stale$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'a4000001-0000-4000-8000-000000000001','openai','ci-eur-model',
      'ci_eur_stale_req_0001','a4000000-0000-4000-8000-000000000001',
      100,100);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Expired FX authorized budget'; END IF;
END $stale$;
RESET ROLE;

UPDATE vns.provider_live_eur_policy
 SET active_fx_snapshot_id='a4000000-0000-4000-8000-000000000002';
SET LOCAL ROLE vns_provider_usage_writer;
DO $checks$
DECLARE
  a uuid;
  a_retry uuid;
  b uuid;
  claim uuid;
  blocked boolean;
BEGIN
  a:=vns.reserve_provider_live_budget(
    'a4000001-0000-4000-8000-000000000001','openai','ci-eur-model',
    'ci_eur_request_0001','a4000000-0000-4000-8000-000000000001',100,100);
  a_retry:=vns.reserve_provider_live_budget(
    'a4000001-0000-4000-8000-000000000001','openai','ci-eur-model',
    'ci_eur_request_0001','a4000000-0000-4000-8000-000000000001',100,100);
  IF a IS NULL OR a<>a_retry THEN
    RAISE EXCEPTION 'EUR reservation retry diverged'; END IF;
  b:=vns.reserve_provider_live_budget(
    'a4000002-0000-4000-8000-000000000002','openai','ci-eur-model',
    'ci_eur_request_0002','a4000000-0000-4000-8000-000000000001',100,100);
  blocked:=false;
  BEGIN
    PERFORM vns.reserve_provider_live_budget(
      'a4000003-0000-4000-8000-000000000003','openai','ci-eur-model',
      'ci_eur_request_0003','a4000000-0000-4000-8000-000000000001',100,100);
  EXCEPTION WHEN SQLSTATE '22023' THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'EUR global cap bypassed by USD budget'; END IF;

  claim:=vns.claim_provider_live_dispatch(a);
  IF claim IS NULL OR vns.claim_provider_live_dispatch(a) IS NOT NULL THEN
    RAISE EXCEPTION 'EUR gated dispatch claim not unique'; END IF;
  -- The second reservation remains unclaimed for FX rotation tests.
  blocked:=false;
  BEGIN
    INSERT INTO vns.provider_live_eur_admissions
      (reservation_id,fx_snapshot_id,reserved_micro_eur)
    VALUES (b,'a4000000-0000-4000-8000-000000000002',1);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Writer can forge EUR admission'; END IF;
END $checks$;
RESET ROLE;

DO $counts$
BEGIN
  IF (SELECT count(*) FROM vns.provider_live_eur_admissions)<>2
    OR (SELECT sum(reserved_micro_eur) FROM vns.provider_live_eur_admissions)<>600
    OR (SELECT count(*) FROM vns.provider_live_reservations)<>2
    OR (SELECT count(*) FROM vns.provider_live_dispatch_claims)<>1
  THEN RAISE EXCEPTION 'EUR conservative reservation accounting wrong'; END IF;
END $counts$;

-- Rotate the independent ceiling: an old reservation may NOT be claimed
-- using a newer and potentially less conservative rate.
UPDATE vns.provider_live_eur_policy
 SET active_fx_snapshot_id='a4000000-0000-4000-8000-000000000004';
DO $rotation$
DECLARE b uuid; blocked boolean:=false;
BEGIN
  SELECT id INTO b FROM vns.provider_live_reservations
    WHERE job_id='a4000002-0000-4000-8000-000000000002';
  BEGIN
    PERFORM vns.claim_provider_live_dispatch(b);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Rotated FX silently repriced claim'; END IF;
END $rotation$;

UPDATE vns.provider_live_eur_policy
 SET active_fx_snapshot_id='a4000000-0000-4000-8000-000000000003';
DO $expired_claim$
DECLARE b uuid; blocked boolean:=false;
BEGIN
  SELECT id INTO b FROM vns.provider_live_reservations
    WHERE job_id='a4000002-0000-4000-8000-000000000002';
  BEGIN
    PERFORM vns.claim_provider_live_dispatch(b);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Expired FX accepted dispatch'; END IF;
END $expired_claim$;

DO $immutability$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    UPDATE vns.provider_live_fx_snapshots
      SET micro_eur_per_micro_usd_nanos=1;
  EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Reviewed FX was mutable'; END IF;
  denied:=false;
  BEGIN
    DELETE FROM vns.provider_live_eur_admissions;
  EXCEPTION WHEN SQLSTATE '22023' THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'EUR history was deletable'; END IF;
END $immutability$;
ROLLBACK;
