-- Disposable CI only: two independent sessions race one 300 micro-EUR slot.
BEGIN;
INSERT INTO vns.jobs(id,kind,idempotency_key) VALUES
 ('a4010001-1111-4111-8111-111111111111','script','ci-eur-race-a'),
 ('a4010002-2222-4222-8222-222222222222','script','ci-eur-race-b');
INSERT INTO vns.provider_live_price_snapshots(
 id,provider,model,price_version,input_micro_usd_per_million,
 cached_micro_usd_per_million,output_micro_usd_per_million,
 expires_at,source_reference,reviewed_by
) VALUES (
 'a4010000-0000-4000-8000-000000000001','openai','ci-eur-race-model',
 'ci_eur_race_price_01',1000000,250000,2000000,
 clock_timestamp()+interval '1 day','CI synthetic EUR race prices','synthetic_ci'
);
INSERT INTO vns.provider_live_fx_snapshots (
 id,micro_eur_per_micro_usd_nanos,source_reference,reviewed_by,expires_at
) VALUES (
 'a4010000-0000-4000-8000-000000000002',1000000000,
 'CI synthetic race FX ceiling','synthetic_ci',
 clock_timestamp()+interval '1 hour'
);
UPDATE vns.provider_live_budget_policy
 SET enabled=true,halted=false,global_cap_micro_usd=1000,
 day_cap_micro_usd=1000,month_cap_micro_usd=1000,
 job_cap_micro_usd=1000,request_cap_micro_usd=1000;
UPDATE vns.provider_live_eur_policy
 SET enabled=true,global_cap_micro_eur=300,
 active_fx_snapshot_id='a4010000-0000-4000-8000-000000000002';
COMMIT;
