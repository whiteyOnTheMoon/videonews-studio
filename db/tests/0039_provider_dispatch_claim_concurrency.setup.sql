-- CI only, committed synthetic fixture for two independent psql sessions.
BEGIN;
INSERT INTO vns.jobs(id,kind,idempotency_key)
VALUES('a3910001-0000-4000-8000-000000000001','script','ci-concurrent-claim-job');
INSERT INTO vns.provider_live_price_snapshots(
 id,provider,model,price_version,input_micro_usd_per_million,
 cached_micro_usd_per_million,output_micro_usd_per_million,
 expires_at,source_reference,reviewed_by
) VALUES(
 'a3910002-0000-4000-8000-000000000002','openai','ci-claim-race-model',
 'ci_claim_race_ver_01',1000000,250000,2000000,
 clock_timestamp()+INTERVAL '1 day',
 'CI synthetic parallel claim prices','synthetic_ci'
);
UPDATE vns.provider_live_budget_policy SET enabled=true,
 global_cap_micro_usd=1000,day_cap_micro_usd=1000,
 month_cap_micro_usd=1000,job_cap_micro_usd=1000,request_cap_micro_usd=1000;
INSERT INTO vns.provider_live_reservations(
 id,job_id,provider,model,request_id,price_snapshot_id,
 max_input_tokens,max_output_tokens,reserved_micro_usd,budget_day,budget_month
) VALUES (
 'a3910003-0000-4000-8000-000000000003',
 'a3910001-0000-4000-8000-000000000001','openai','ci-claim-race-model',
 'ci_claim_race_req_0001','a3910002-0000-4000-8000-000000000002',
 100,100,300,
 (clock_timestamp() AT TIME ZONE 'UTC')::date,
 date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date
);
COMMIT;
