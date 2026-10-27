-- P1-09-FU #230: append-only, provider-origin metering evidence.
-- This DOES NOT authorize billable calls, assert invoice prices, or reconcile budgets.
-- Dormant, NOLOGIN / NO MEMBERSHIP roles: only a future audited adapter may be
-- given a dedicated login after independent authorization and budget tests.
BEGIN;

CREATE ROLE vns_provider_usage_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE vns_provider_usage_writer
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

CREATE TABLE vns.provider_usage_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES vns.jobs(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('openai','google_gemini')),
  model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9_-]{12,80}$'),
  response_id text NOT NULL CHECK (response_id ~ '^[A-Za-z0-9_-]{12,80}$'),
  price_version text NOT NULL CHECK (price_version ~ '^[A-Za-z0-9_-]{12,80}$'),
  input_tokens bigint NOT NULL CHECK (input_tokens BETWEEN 0 AND 100000000),
  output_tokens bigint NOT NULL CHECK (output_tokens BETWEEN 0 AND 100000000),
  cached_input_tokens bigint NOT NULL CHECK (
    cached_input_tokens BETWEEN 0 AND input_tokens
  ),
  calculated_cost_micro_usd bigint NOT NULL CHECK (
    calculated_cost_micro_usd BETWEEN 0 AND 999999999999999
  ),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  measurement_source text NOT NULL DEFAULT 'provider_response'
    CHECK (measurement_source = 'provider_response'),
  reconciled boolean NOT NULL DEFAULT false CHECK (reconciled = false),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT provider_usage_unique_request UNIQUE(job_id,provider,request_id),
  CONSTRAINT provider_usage_unique_response UNIQUE(provider,response_id)
);

CREATE INDEX provider_usage_receipts_job_idx
  ON vns.provider_usage_receipts(job_id,recorded_at DESC);

CREATE FUNCTION vns.reject_provider_usage_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $reject$
BEGIN
  RAISE EXCEPTION 'provider usage evidence is immutable' USING ERRCODE='22023';
END;
$reject$;
CREATE TRIGGER reject_provider_usage_update_delete
  BEFORE UPDATE OR DELETE ON vns.provider_usage_receipts
  FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_provider_usage_truncate
  BEFORE TRUNCATE ON vns.provider_usage_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

GRANT USAGE ON SCHEMA vns
  TO vns_provider_usage_executor,vns_provider_usage_writer;
GRANT INSERT,SELECT ON vns.provider_usage_receipts
  TO vns_provider_usage_executor;

CREATE FUNCTION vns.record_provider_usage_evidence(
  p_job_id uuid,p_provider text,p_model text,
  p_request_id text,p_response_id text,p_price_version text,
  p_input_tokens bigint,p_output_tokens bigint,
  p_cached_input_tokens bigint,p_calculated_cost_micro_usd bigint
) RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $body$
DECLARE
  v_id uuid;
BEGIN
  -- Deliberately do NOT infer missing numbers or pricing.
  IF p_job_id IS NULL OR p_provider IS NULL
     OR p_provider NOT IN ('openai','google_gemini')
     OR p_model IS NULL OR p_model !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'
     OR p_request_id IS NULL OR p_request_id !~ '^[A-Za-z0-9_-]{12,80}$'
     OR p_response_id IS NULL OR p_response_id !~ '^[A-Za-z0-9_-]{12,80}$'
     OR p_price_version IS NULL OR p_price_version !~ '^[A-Za-z0-9_-]{12,80}$'
     OR p_input_tokens IS NULL OR p_input_tokens NOT BETWEEN 0 AND 100000000
     OR p_output_tokens IS NULL OR p_output_tokens NOT BETWEEN 0 AND 100000000
     OR p_cached_input_tokens IS NULL
     OR p_cached_input_tokens NOT BETWEEN 0 AND p_input_tokens
     OR p_calculated_cost_micro_usd IS NULL
     OR p_calculated_cost_micro_usd NOT BETWEEN 0 AND 999999999999999
  THEN RAISE EXCEPTION 'invalid provider usage evidence' USING ERRCODE='22023';
  END IF;

  -- Uniqueness serializes competing writers. An identical replay returns the
  -- original immutable ID; a changed payload or cross-job response reuse fails.
  BEGIN
    INSERT INTO vns.provider_usage_receipts(
      job_id,provider,model,request_id,response_id,price_version,
      input_tokens,output_tokens,cached_input_tokens,calculated_cost_micro_usd
    ) VALUES(
      p_job_id,p_provider,p_model,p_request_id,p_response_id,p_price_version,
      p_input_tokens,p_output_tokens,p_cached_input_tokens,p_calculated_cost_micro_usd
    )
    ON CONFLICT ON CONSTRAINT provider_usage_unique_request DO NOTHING
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'conflicting provider response identity' USING ERRCODE='22023';
  END;

  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT id INTO v_id FROM vns.provider_usage_receipts
   WHERE job_id=p_job_id AND provider=p_provider AND request_id=p_request_id
     AND response_id=p_response_id AND model=p_model
     AND price_version=p_price_version AND input_tokens=p_input_tokens
     AND output_tokens=p_output_tokens AND cached_input_tokens=p_cached_input_tokens
     AND calculated_cost_micro_usd=p_calculated_cost_micro_usd;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'conflicting provider usage replay' USING ERRCODE='22023';
  END IF;
  RETURN v_id;
END;
$body$;

REVOKE ALL ON FUNCTION vns.record_provider_usage_evidence(
 uuid,text,text,text,text,text,bigint,bigint,bigint,bigint) FROM PUBLIC;
ALTER FUNCTION vns.record_provider_usage_evidence(
 uuid,text,text,text,text,text,bigint,bigint,bigint,bigint)
 OWNER TO vns_provider_usage_executor;
GRANT EXECUTE ON FUNCTION vns.record_provider_usage_evidence(
 uuid,text,text,text,text,text,bigint,bigint,bigint,bigint)
 TO vns_provider_usage_writer;

COMMENT ON TABLE vns.provider_usage_receipts IS
 'Dormant append-only provider response metering evidence; USD calculation is not an invoice, reservation or spend approval. No runtime writer LOGIN.';
COMMENT ON COLUMN vns.provider_usage_receipts.reconciled IS
 'Always false until separately reviewed atomic actual-versus-reservation settlement exists.';
INSERT INTO vns.schema_migrations(version) VALUES ('0036_provider_usage_evidence');
COMMIT;
