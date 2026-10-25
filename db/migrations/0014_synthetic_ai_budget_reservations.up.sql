-- P1-09 / 0014: persistent, SYNTHETIC-ONLY budget reservations.
-- Operator has NOT approved spending or execution against the live VPS.
-- One budget-date row is locked to serialize reservations across jobs.
BEGIN;

CREATE TABLE vns.synthetic_ai_budget_days (
  budget_day date PRIMARY KEY,
  cap_micro_usd bigint NOT NULL DEFAULT 2000000 CHECK (cap_micro_usd = 2000000),
  reserved_micro_usd bigint NOT NULL DEFAULT 0
    CHECK (reserved_micro_usd BETWEEN 0 AND 2000000)
);

CREATE TABLE vns.synthetic_ai_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES vns.jobs(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'synthetic_openai'
    CHECK (provider = 'synthetic_openai'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{12,80}$'),
  stage text NOT NULL CHECK (stage IN ('topic_triage','script_draft','fact_audit')),
  model text NOT NULL CHECK (model IN ('gpt-6-luna','gpt-6.1-sol')),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 20000),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 5000),
  reserved_micro_usd bigint NOT NULL CHECK (reserved_micro_usd BETWEEN 1 AND 100000),
  budget_day date NOT NULL REFERENCES vns.synthetic_ai_budget_days(budget_day)
    ON DELETE RESTRICT,
  source_type text NOT NULL DEFAULT 'synthetic' CHECK (source_type = 'synthetic'),
  price_snapshot date NOT NULL DEFAULT DATE '2026-10-25'
    CHECK (price_snapshot = DATE '2026-10-25'),
  state text NOT NULL DEFAULT 'reserved' CHECK (state = 'reserved'),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT synthetic_ai_reservations_request_unique UNIQUE (job_id, provider, request_id)
);

CREATE INDEX synthetic_ai_reservations_job_day_idx
  ON vns.synthetic_ai_reservations(job_id, budget_day);

CREATE FUNCTION vns.reserve_synthetic_ai_budget(
  p_job_id uuid,
  p_request_id text,
  p_stage text,
  p_model text,
  p_max_input_tokens integer,
  p_max_output_tokens integer,
  p_budget_day date
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, vns
AS $reserve$
DECLARE
  v_input_rate bigint;
  v_output_rate bigint;
  v_input_limit integer;
  v_output_limit integer;
  v_expected_model text;
  v_micro_usd bigint;
  v_existing vns.synthetic_ai_reservations%ROWTYPE;
  v_job_reserved bigint;
  v_day_reserved bigint;
  v_id uuid;
BEGIN
  -- No usage of real provider keys, unknown prices, tools, or live date.
  IF p_job_id IS NULL
      OR p_request_id IS NULL
      OR p_request_id !~ '^[A-Za-z0-9_-]{12,80}$'
      OR p_stage IS NULL
      OR p_model IS NULL
      OR p_budget_day IS NULL
      OR p_max_input_tokens IS NULL
      OR p_max_output_tokens IS NULL THEN
    RAISE EXCEPTION 'invalid synthetic budget request' USING ERRCODE = '22023';
  END IF;
  CASE p_stage
    WHEN 'topic_triage' THEN
      v_expected_model := 'gpt-6-luna';
      v_input_limit := 4000;
      v_output_limit := 700;
      v_input_rate := 100000;
      v_output_rate := 500000;
    WHEN 'script_draft' THEN
      v_expected_model := 'gpt-6.1-sol';
      v_input_limit := 20000;
      v_output_limit := 5000;
      v_input_rate := 2000000;
      v_output_rate := 10000000;
    WHEN 'fact_audit' THEN
      v_expected_model := 'gpt-6.1-sol';
      v_input_limit := 12000;
      v_output_limit := 2500;
      v_input_rate := 2000000;
      v_output_rate := 10000000;
    ELSE
      RAISE EXCEPTION 'unrecognized synthetic stage' USING ERRCODE = '22023';
  END CASE;
  IF p_model <> v_expected_model
      OR p_max_input_tokens NOT BETWEEN 1 AND v_input_limit
      OR p_max_output_tokens NOT BETWEEN 1 AND v_output_limit THEN
    RAISE EXCEPTION 'synthetic model or token limit not approved'
      USING ERRCODE = '22023';
  END IF;

  v_micro_usd := ceil((
    p_max_input_tokens::numeric * v_input_rate::numeric
    + p_max_output_tokens::numeric * v_output_rate::numeric
  ) / 1000000)::bigint;

  IF v_micro_usd NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'synthetic per-request budget exceeded'
      USING ERRCODE = '22023';
  END IF;

  -- Create-if-absent handles concurrent new-day initialization.
  INSERT INTO vns.synthetic_ai_budget_days(budget_day)
  VALUES (p_budget_day) ON CONFLICT (budget_day) DO NOTHING;

  -- Explicit row lock serializes separate jobs attempting to spend same day.
  SELECT reserved_micro_usd INTO v_day_reserved
  FROM vns.synthetic_ai_budget_days WHERE budget_day = p_budget_day
  FOR UPDATE;

  SELECT * INTO v_existing FROM vns.synthetic_ai_reservations
  WHERE job_id=p_job_id AND provider='synthetic_openai'
    AND request_id=p_request_id;
  IF FOUND THEN
    IF v_existing.stage IS DISTINCT FROM p_stage
        OR v_existing.model IS DISTINCT FROM p_model
        OR v_existing.max_input_tokens IS DISTINCT FROM p_max_input_tokens
        OR v_existing.max_output_tokens IS DISTINCT FROM p_max_output_tokens
        OR v_existing.reserved_micro_usd IS DISTINCT FROM v_micro_usd
        OR v_existing.budget_day IS DISTINCT FROM p_budget_day THEN
      RAISE EXCEPTION 'conflicting synthetic budget retry'
        USING ERRCODE = '22023';
    END IF;
    RETURN v_existing.id;
  END IF;

  SELECT coalesce(sum(reserved_micro_usd),0)::bigint INTO v_job_reserved
  FROM vns.synthetic_ai_reservations
  WHERE job_id=p_job_id AND budget_day=p_budget_day;
  IF v_job_reserved + v_micro_usd > 250000
      OR v_day_reserved + v_micro_usd > 2000000 THEN
    RAISE EXCEPTION 'synthetic budget exhausted' USING ERRCODE = '22023';
  END IF;

  INSERT INTO vns.synthetic_ai_reservations(
    job_id, request_id, stage, model, max_input_tokens,
    max_output_tokens, reserved_micro_usd, budget_day
  ) VALUES (
    p_job_id, p_request_id, p_stage, p_model, p_max_input_tokens,
    p_max_output_tokens, v_micro_usd, p_budget_day
  ) RETURNING id INTO v_id;

  UPDATE vns.synthetic_ai_budget_days
  SET reserved_micro_usd = reserved_micro_usd + v_micro_usd
  WHERE budget_day=p_budget_day;
  RETURN v_id;
END;
$reserve$;

REVOKE ALL ON FUNCTION vns.reserve_synthetic_ai_budget(
  uuid,text,text,text,integer,integer,date
) FROM PUBLIC;

CREATE FUNCTION vns.reject_synthetic_budget_mutation()
RETURNS trigger LANGUAGE plpgsql AS $deny$
BEGIN
  RAISE EXCEPTION 'synthetic budget history cannot be removed or amended'
    USING ERRCODE = '22023';
END;
$deny$;

CREATE TRIGGER synthetic_ai_reservations_no_change
  BEFORE UPDATE OR DELETE ON vns.synthetic_ai_reservations
  FOR EACH ROW EXECUTE FUNCTION vns.reject_synthetic_budget_mutation();
CREATE TRIGGER synthetic_ai_reservations_no_truncate
  BEFORE TRUNCATE ON vns.synthetic_ai_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_synthetic_budget_mutation();
CREATE TRIGGER synthetic_ai_budget_days_no_delete
  BEFORE DELETE ON vns.synthetic_ai_budget_days
  FOR EACH ROW EXECUTE FUNCTION vns.reject_synthetic_budget_mutation();
CREATE TRIGGER synthetic_ai_budget_days_no_truncate
  BEFORE TRUNCATE ON vns.synthetic_ai_budget_days
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_synthetic_budget_mutation();

COMMENT ON TABLE vns.synthetic_ai_budget_days IS
  'Synthetic-only persistent daily reservation counter; no real spend approval.';
COMMENT ON TABLE vns.synthetic_ai_reservations IS
  'Synthetic-only irreversible reservation history; never authorizes network use or invoices.';

INSERT INTO vns.schema_migrations(version)
VALUES ('0014_synthetic_ai_budget_reservations');
COMMIT;
