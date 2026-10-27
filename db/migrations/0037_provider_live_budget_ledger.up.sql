-- P1-09 / #230: offline provider budget reservations and evidenced settlement.
-- NEVER a spending authorization, vendor client, live worker writer or VPS migration.
-- Applies ONLY after all earlier 0001-0036 migrations in disposable CI.
BEGIN;

CREATE TABLE vns.provider_live_price_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('openai','google_gemini')),
  model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  price_version text NOT NULL CHECK (price_version ~ '^[A-Za-z0-9_-]{12,80}$'),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  input_micro_usd_per_million bigint NOT NULL CHECK (
    input_micro_usd_per_million BETWEEN 0 AND 1000000000000),
  cached_micro_usd_per_million bigint NOT NULL CHECK (
    cached_micro_usd_per_million BETWEEN 0 AND 1000000000000),
  output_micro_usd_per_million bigint NOT NULL CHECK (
    output_micro_usd_per_million BETWEEN 0 AND 1000000000000),
  expires_at timestamptz NOT NULL,
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 12 AND 512),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 3 AND 120),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT live_price_unique_version UNIQUE(provider,model,price_version),
  CHECK (cached_micro_usd_per_million <= input_micro_usd_per_million),
  CHECK (input_micro_usd_per_million+output_micro_usd_per_million > 0)
);
CREATE TRIGGER prevent_live_price_change
  BEFORE UPDATE OR DELETE ON vns.provider_live_price_snapshots
  FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER prevent_live_price_truncate
  BEFORE TRUNCATE ON vns.provider_live_price_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

-- Default zero limits and disabled. No provider calls can be authorized by
-- creating a snapshot. Explicit independent budget/FX/credential approval
-- is required BEFORE any future worker is allowed to use this ledger.
CREATE TABLE vns.provider_live_budget_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  halted boolean NOT NULL DEFAULT false,
  global_cap_micro_usd bigint NOT NULL DEFAULT 0
    CHECK (global_cap_micro_usd BETWEEN 0 AND 999999999999999),
  day_cap_micro_usd bigint NOT NULL DEFAULT 0
    CHECK (day_cap_micro_usd BETWEEN 0 AND 999999999999999),
  month_cap_micro_usd bigint NOT NULL DEFAULT 0
    CHECK (month_cap_micro_usd BETWEEN 0 AND 999999999999999),
  job_cap_micro_usd bigint NOT NULL DEFAULT 0
    CHECK (job_cap_micro_usd BETWEEN 0 AND 999999999999999),
  request_cap_micro_usd bigint NOT NULL DEFAULT 0
    CHECK (request_cap_micro_usd BETWEEN 0 AND 999999999999999),
  CHECK (NOT enabled OR
    (global_cap_micro_usd > 0 AND day_cap_micro_usd > 0
     AND month_cap_micro_usd > 0 AND job_cap_micro_usd > 0
     AND request_cap_micro_usd > 0))
);
INSERT INTO vns.provider_live_budget_policy(singleton) VALUES(true);

CREATE TABLE vns.provider_live_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES vns.jobs(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('openai','google_gemini')),
  model text NOT NULL,
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{12,80}$'),
  price_snapshot_id uuid NOT NULL REFERENCES vns.provider_live_price_snapshots(id),
  max_input_tokens bigint NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 100000000),
  max_output_tokens bigint NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 100000000),
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd BETWEEN 1 AND 999999999999999),
  budget_day date NOT NULL,
  budget_month date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_live_unique_request UNIQUE(job_id,provider,request_id),
  CHECK (budget_month = date_trunc('month',budget_day::timestamp)::date)
);
CREATE INDEX provider_live_budget_day_idx ON vns.provider_live_reservations(budget_day);
CREATE INDEX provider_live_budget_month_idx ON vns.provider_live_reservations(budget_month);
CREATE INDEX provider_live_budget_job_idx ON vns.provider_live_reservations(job_id);

CREATE TABLE vns.provider_live_settlements (
  reservation_id uuid PRIMARY KEY REFERENCES vns.provider_live_reservations(id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL UNIQUE REFERENCES vns.provider_usage_receipts(id) ON DELETE RESTRICT,
  actual_micro_usd bigint NOT NULL CHECK (actual_micro_usd BETWEEN 0 AND 999999999999999),
  settled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE vns.provider_live_budget_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES vns.provider_live_reservations(id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL REFERENCES vns.provider_usage_receipts(id) ON DELETE RESTRICT,
  code text NOT NULL DEFAULT 'usage_conflict_halted' CHECK (code='usage_conflict_halted'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reservation_id,receipt_id)
);

-- Append-only evidence for reservations, settlements, incidents, snapshots.
-- Only an independent policy administrator may alter the single budget policy.
DO $triggers$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY[
    'provider_live_reservations','provider_live_settlements','provider_live_budget_incidents'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER prevent_%I_change BEFORE UPDATE OR DELETE ON vns.%I ' ||
      'FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change()',
      tab,tab);
    EXECUTE format(
      'CREATE TRIGGER prevent_%I_truncate BEFORE TRUNCATE ON vns.%I ' ||
      'FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change()',
      tab,tab);
  END LOOP;
END $triggers$;

-- SECURITY DEFINER functions have only the NOLOGIN executor's table ACLs.
GRANT SELECT ON vns.provider_live_price_snapshots,vns.provider_live_budget_policy,
  vns.provider_live_reservations,vns.provider_live_settlements,
  vns.provider_usage_receipts TO vns_provider_usage_executor;
GRANT INSERT ON vns.provider_live_reservations,vns.provider_live_settlements,
  vns.provider_live_budget_incidents TO vns_provider_usage_executor;
GRANT UPDATE(halted) ON vns.provider_live_budget_policy TO vns_provider_usage_executor;

CREATE FUNCTION vns.reserve_provider_live_budget(
  p_job_id uuid,p_provider text,p_model text,p_request_id text,
  p_price_snapshot_id uuid,p_max_input bigint,p_max_output bigint
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $reserve$
DECLARE
  p vns.provider_live_budget_policy%ROWTYPE;
  price vns.provider_live_price_snapshots%ROWTYPE;
  existing vns.provider_live_reservations%ROWTYPE;
  v_date date;
  v_month date;
  v_amount numeric;
  v_global numeric;
  v_day numeric;
  v_month_total numeric;
  v_job numeric;
  v_id uuid;
BEGIN
  IF p_job_id IS NULL OR p_provider NOT IN ('openai','google_gemini')
    OR p_model IS NULL OR p_request_id IS NULL
    OR p_request_id !~ '^[A-Za-z0-9_-]{12,80}$'
    OR p_price_snapshot_id IS NULL
    OR p_max_input NOT BETWEEN 1 AND 100000000
    OR p_max_output NOT BETWEEN 1 AND 100000000
  THEN RAISE EXCEPTION 'Invalid live reservation' USING ERRCODE='22023'; END IF;

  -- Single row lock serializes even separate jobs and independent PG sessions.
  -- Aborts on missing row; no permissive default cap.
  SELECT * INTO STRICT p FROM vns.provider_live_budget_policy WHERE singleton FOR UPDATE;
  IF NOT p.enabled OR p.halted THEN
    RAISE EXCEPTION 'Live provider budget unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT price FROM vns.provider_live_price_snapshots
   WHERE id=p_price_snapshot_id;
  IF price.provider IS DISTINCT FROM p_provider OR price.model IS DISTINCT FROM p_model
    OR price.expires_at <= clock_timestamp() OR price.currency <> 'USD'
  THEN RAISE EXCEPTION 'Price snapshot unavailable' USING ERRCODE='22023'; END IF;
  -- The *maximum* possible input is charged at noncached price. Never
  -- assume cache discounts before the request is completed.
  v_amount := ceil((p_max_input::numeric * price.input_micro_usd_per_million
    + p_max_output::numeric * price.output_micro_usd_per_million)/1000000);
  IF v_amount NOT BETWEEN 1 AND p.request_cap_micro_usd THEN
    RAISE EXCEPTION 'Request budget exceeded' USING ERRCODE='22023';
  END IF;
  v_date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
  v_month := date_trunc('month',v_date::timestamp)::date;

  SELECT * INTO existing FROM vns.provider_live_reservations
   WHERE job_id=p_job_id AND provider=p_provider AND request_id=p_request_id;
  IF FOUND THEN
    IF existing.model IS DISTINCT FROM p_model
       OR existing.price_snapshot_id IS DISTINCT FROM p_price_snapshot_id
       OR existing.max_input_tokens IS DISTINCT FROM p_max_input
       OR existing.max_output_tokens IS DISTINCT FROM p_max_output
       OR existing.reserved_micro_usd IS DISTINCT FROM v_amount
    THEN RAISE EXCEPTION 'Conflicting live budget retry' USING ERRCODE='22023'; END IF;
    RETURN existing.id;
  END IF;
  -- All four exposures include actual costs for settled requests and full
  -- reserved cost for pending requests. No refund for missing evidence.
  WITH charges AS (
    SELECT a.job_id,a.budget_day,a.budget_month,
      coalesce(s.actual_micro_usd,a.reserved_micro_usd)::numeric AS exposure
    FROM vns.provider_live_reservations a
    LEFT JOIN vns.provider_live_settlements s ON s.reservation_id=a.id
  )
  SELECT coalesce(sum(exposure),0),
         coalesce(sum(exposure) FILTER (WHERE budget_day=v_date),0),
         coalesce(sum(exposure) FILTER (WHERE budget_month=v_month),0),
         coalesce(sum(exposure) FILTER (WHERE job_id=p_job_id),0)
  INTO v_global,v_day,v_month_total,v_job FROM charges;
  IF v_global+v_amount > p.global_cap_micro_usd
    OR v_day+v_amount > p.day_cap_micro_usd
    OR v_month_total+v_amount > p.month_cap_micro_usd
    OR v_job+v_amount > p.job_cap_micro_usd
  THEN RAISE EXCEPTION 'Live provider budget exhausted' USING ERRCODE='22023'; END IF;

  INSERT INTO vns.provider_live_reservations(
    job_id,provider,model,request_id,price_snapshot_id,max_input_tokens,
    max_output_tokens,reserved_micro_usd,budget_day,budget_month
  ) VALUES(
    p_job_id,p_provider,p_model,p_request_id,p_price_snapshot_id,p_max_input,
    p_max_output,v_amount::bigint,v_date,v_month
  ) RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN no_data_found THEN
  RAISE EXCEPTION 'Live price or budget unavailable' USING ERRCODE='55000';
END;
$reserve$;

CREATE FUNCTION vns.settle_provider_live_budget(p_reservation_id uuid,p_receipt_id uuid)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $settle$
DECLARE
  p vns.provider_live_budget_policy%ROWTYPE;
  reservation vns.provider_live_reservations%ROWTYPE;
  receipt vns.provider_usage_receipts%ROWTYPE;
  price vns.provider_live_price_snapshots%ROWTYPE;
  existing vns.provider_live_settlements%ROWTYPE;
  expected numeric;
BEGIN
  IF p_reservation_id IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Invalid settlement identity' USING ERRCODE='22023';
  END IF;
  SELECT * INTO STRICT p FROM vns.provider_live_budget_policy WHERE singleton FOR UPDATE;
  SELECT * INTO STRICT reservation FROM vns.provider_live_reservations
    WHERE id=p_reservation_id;
  SELECT * INTO STRICT receipt FROM vns.provider_usage_receipts WHERE id=p_receipt_id;
  SELECT * INTO STRICT price FROM vns.provider_live_price_snapshots
    WHERE id=reservation.price_snapshot_id;

  SELECT * INTO existing FROM vns.provider_live_settlements
    WHERE reservation_id=p_reservation_id;
  IF FOUND THEN
    IF existing.receipt_id=p_receipt_id THEN RETURN 'settled'; END IF;
    -- A conflicting replay is never silently accepted.
    RAISE EXCEPTION 'Conflicting settlement replay' USING ERRCODE='22023';
  END IF;
  IF p.halted THEN RETURN 'halted'; END IF;

  expected := ceil((
    (receipt.input_tokens-receipt.cached_input_tokens)::numeric
       * price.input_micro_usd_per_million
    + receipt.cached_input_tokens::numeric * price.cached_micro_usd_per_million
    + receipt.output_tokens::numeric * price.output_micro_usd_per_million
  )/1000000);
  IF receipt.job_id IS DISTINCT FROM reservation.job_id
    OR receipt.provider IS DISTINCT FROM reservation.provider
    OR receipt.model IS DISTINCT FROM reservation.model
    OR receipt.request_id IS DISTINCT FROM reservation.request_id
    OR receipt.price_version IS DISTINCT FROM price.price_version
    OR receipt.currency <> 'USD'
    OR receipt.input_tokens > reservation.max_input_tokens
    OR receipt.output_tokens > reservation.max_output_tokens
    OR receipt.calculated_cost_micro_usd IS DISTINCT FROM expected
    OR expected > reservation.reserved_micro_usd
  THEN
    -- Never raise after setting halted: exception would undo the stop flag.
    -- Return a durable halt instead; receipt remains immutable for review.
    UPDATE vns.provider_live_budget_policy SET halted=true WHERE singleton;
    INSERT INTO vns.provider_live_budget_incidents(reservation_id,receipt_id)
      VALUES(p_reservation_id,p_receipt_id)
      ON CONFLICT DO NOTHING;
    RETURN 'halted';
  END IF;

  INSERT INTO vns.provider_live_settlements(
    reservation_id,receipt_id,actual_micro_usd)
  VALUES(reservation.id,receipt.id,expected::bigint);
  RETURN 'settled';
EXCEPTION WHEN no_data_found THEN
  RAISE EXCEPTION 'Unverified live settlement' USING ERRCODE='55000';
END;
$settle$;

REVOKE ALL ON FUNCTION vns.reserve_provider_live_budget(
  uuid,text,text,text,uuid,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.settle_provider_live_budget(uuid,uuid) FROM PUBLIC;
ALTER FUNCTION vns.reserve_provider_live_budget(
  uuid,text,text,text,uuid,bigint,bigint) OWNER TO vns_provider_usage_executor;
ALTER FUNCTION vns.settle_provider_live_budget(uuid,uuid) OWNER TO vns_provider_usage_executor;
GRANT EXECUTE ON FUNCTION vns.reserve_provider_live_budget(
  uuid,text,text,text,uuid,bigint,bigint) TO vns_provider_usage_writer;
GRANT EXECUTE ON FUNCTION vns.settle_provider_live_budget(uuid,uuid)
  TO vns_provider_usage_writer;

COMMENT ON TABLE vns.provider_live_budget_policy IS
 'Default OFF, zero USD caps and NO runtime login. Not authorized EUR canary or provider dispatch.';
COMMENT ON TABLE vns.provider_live_reservations IS
 'Offline immutable committed worst-case text-only USD exposure for job/day/month/project.';
COMMENT ON TABLE vns.provider_live_settlements IS
 'Offline immutable real usage reconciliation reference; not a vendor invoice.';
INSERT INTO vns.schema_migrations(version) VALUES('0037_provider_live_budget_ledger');
COMMIT;
