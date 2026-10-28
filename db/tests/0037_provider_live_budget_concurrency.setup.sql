-- CI only: leaves two disposable jobs competing for $0.0003 of budget.
-- This setup is NOT included in the migration or the VPS.
BEGIN;
INSERT INTO vns.jobs(id,kind,idempotency_key) VALUES
 ('b3710001-1111-4111-8111-111111111111','script','ci-usage-budget-parallel-a'),
 ('b3710002-2222-4222-8222-222222222222','script','ci-usage-budget-parallel-b');
INSERT INTO vns.provider_live_price_snapshots(
 id,provider,model,price_version,input_micro_usd_per_million,
 cached_micro_usd_per_million,output_micro_usd_per_million,
 expires_at,source_reference,reviewed_by
) VALUES(
 'b3710000-0000-4000-8000-000000000001','openai','ci-parallel-model',
 'ci_parallel_price_001',1000000,250000,2000000,
 clock_timestamp()+INTERVAL '1 day','CI invented concurrency prices','synthetic_ci'
);
UPDATE vns.provider_live_budget_policy SET enabled=true,halted=false,
 global_cap_micro_usd=300,day_cap_micro_usd=300,
 month_cap_micro_usd=300,job_cap_micro_usd=300,request_cap_micro_usd=300;
-- The newer EUR gate is also installed by the time CI executes this
-- original USD race. Only synthetic FX is used; no live approval.
INSERT INTO vns.provider_live_fx_snapshots (
 id,micro_eur_per_micro_usd_nanos,source_reference,reviewed_by,expires_at
) VALUES (
 'b3710000-0000-4000-8000-000000000002',1000000000,
 'CI synthetic USD race FX review','synthetic_ci',
 clock_timestamp()+interval '1 hour'
);
UPDATE vns.provider_live_eur_policy SET
 enabled=true,global_cap_micro_eur=1000000,
 active_fx_snapshot_id='b3710000-0000-4000-8000-000000000002';
COMMIT;
