-- P1-09: offline-only synthetic per-job usage receipts.
-- DO NOT execute against the VPS without separately approved deployment.
-- No role memberships, service logins, passwords or live usage are enabled.
BEGIN;

CREATE TABLE vns.job_token_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES vns.jobs(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (
    provider ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  model text NOT NULL CHECK (
    model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
  ),
  request_id text NOT NULL CHECK (
    request_id ~ '^[A-Za-z0-9_-]{12,80}$'
  ),
  input_tokens bigint NOT NULL CHECK (input_tokens BETWEEN 0 AND 100000000),
  output_tokens bigint NOT NULL CHECK (output_tokens BETWEEN 0 AND 100000000),
  input_micro_usd_per_million bigint NOT NULL CHECK (
    input_micro_usd_per_million BETWEEN 0 AND 1000000000000
  ),
  output_micro_usd_per_million bigint NOT NULL CHECK (
    output_micro_usd_per_million BETWEEN 0 AND 1000000000000
  ),
  estimated_cost_micro_usd numeric(18,0) GENERATED ALWAYS AS (
    ceil((
      input_tokens::numeric * input_micro_usd_per_million::numeric +
      output_tokens::numeric * output_micro_usd_per_million::numeric
    ) / 1000000)
  ) STORED,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source_type text NOT NULL DEFAULT 'synthetic' CHECK (source_type = 'synthetic'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT job_token_usage_unique_request UNIQUE (job_id, provider, request_id),
  CONSTRAINT job_token_usage_cost_bound CHECK (
    estimated_cost_micro_usd BETWEEN 0 AND 1000000000000000
  )
);

CREATE INDEX job_token_usage_job_idx
  ON vns.job_token_usage(job_id, recorded_at DESC);

-- Neither caller inputs nor defaults can mark simulated usage as invoiced.
-- Running application roles receive no table or function access.
CREATE FUNCTION vns.record_synthetic_token_usage(
  p_job_id uuid,
  p_provider text,
  p_model text,
  p_request_id text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_input_micro_usd_per_million bigint,
  p_output_micro_usd_per_million bigint
) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, vns
AS $receipt$
DECLARE
  receipt_id uuid;
BEGIN
  IF p_job_id IS NULL
     OR p_provider IS NULL
     OR p_provider !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR p_model IS NULL
     OR p_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR p_request_id IS NULL
     OR p_request_id !~ '^[A-Za-z0-9_-]{12,80}$'
     OR p_input_tokens IS NULL
     OR p_input_tokens NOT BETWEEN 0 AND 100000000
     OR p_output_tokens IS NULL
     OR p_output_tokens NOT BETWEEN 0 AND 100000000
     OR p_input_micro_usd_per_million IS NULL
     OR p_input_micro_usd_per_million NOT BETWEEN 0 AND 1000000000000
     OR p_output_micro_usd_per_million IS NULL
     OR p_output_micro_usd_per_million NOT BETWEEN 0 AND 1000000000000 THEN
    RAISE EXCEPTION 'invalid synthetic token receipt' USING ERRCODE = '22023';
  END IF;

  INSERT INTO vns.job_token_usage(
    job_id, provider, model, request_id,
    input_tokens, output_tokens,
    input_micro_usd_per_million, output_micro_usd_per_million
  ) VALUES (
    p_job_id, p_provider, p_model, p_request_id,
    p_input_tokens, p_output_tokens,
    p_input_micro_usd_per_million, p_output_micro_usd_per_million
  )
  ON CONFLICT (job_id, provider, request_id) DO NOTHING
  RETURNING id INTO receipt_id;

  IF receipt_id IS NOT NULL THEN
    RETURN receipt_id;
  END IF;

  -- A concurrent conflicting INSERT is resolved by the unique index;
  -- a second statement in READ COMMITTED sees the committed row.
  SELECT id INTO receipt_id FROM vns.job_token_usage
  WHERE job_id = p_job_id
    AND provider = p_provider
    AND model = p_model
    AND request_id = p_request_id
    AND input_tokens = p_input_tokens
    AND output_tokens = p_output_tokens
    AND input_micro_usd_per_million = p_input_micro_usd_per_million
    AND output_micro_usd_per_million = p_output_micro_usd_per_million;
  IF receipt_id IS NULL THEN
    RAISE EXCEPTION 'conflicting synthetic token receipt'
      USING ERRCODE = '22023';
  END IF;
  RETURN receipt_id;
END;
$receipt$;

REVOKE ALL ON FUNCTION vns.record_synthetic_token_usage(
  uuid,text,text,text,bigint,bigint,bigint,bigint
) FROM PUBLIC;

CREATE FUNCTION vns.reject_token_usage_mutation()
RETURNS trigger LANGUAGE plpgsql AS $reject$
BEGIN
  RAISE EXCEPTION 'token usage receipt is append-only' USING ERRCODE = '22023';
END;
$reject$;

CREATE TRIGGER reject_token_usage_update_delete
  BEFORE UPDATE OR DELETE ON vns.job_token_usage
  FOR EACH ROW EXECUTE FUNCTION vns.reject_token_usage_mutation();
CREATE TRIGGER reject_token_usage_truncate
  BEFORE TRUNCATE ON vns.job_token_usage
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_token_usage_mutation();

COMMENT ON TABLE vns.job_token_usage IS
  'Offline-only immutable synthetic token receipts; real provider ingestion is NOT enabled.';
COMMENT ON COLUMN vns.job_token_usage.estimated_cost_micro_usd IS
  'Estimated integer USD micro-units computed from explicit synthetic rates; NOT invoice amounts.';

INSERT INTO vns.schema_migrations(version)
VALUES ('0013_synthetic_token_usage');
COMMIT;
