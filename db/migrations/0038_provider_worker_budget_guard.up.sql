-- P1-09 / #230: offline-only projection of SQL-authoritative reservations
-- and a durable emergency halt for missing/ambiguous vendor usage.
-- No provider client, runtime LOGIN, seed, enabled budget or VPS approval.
BEGIN;

CREATE TABLE vns.provider_live_worker_faults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES vns.provider_live_reservations(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN (
    'response_missing','response_invalid','quote_over_reservation',
    'persistence_failed','settlement_unconfirmed'
  )),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(reservation_id,reason)
);

CREATE TRIGGER reject_provider_live_worker_fault_change
  BEFORE UPDATE OR DELETE ON vns.provider_live_worker_faults
  FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_provider_live_worker_fault_truncate
  BEFORE TRUNCATE ON vns.provider_live_worker_faults
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

GRANT INSERT ON vns.provider_live_worker_faults TO vns_provider_usage_executor;

-- Let the trusted least-privilege writer obtain server-owned numbers for a
-- previously committed reservation. Caller-supplied rates are never trusted.
CREATE FUNCTION vns.get_provider_live_reservation(p_id uuid)
RETURNS TABLE(
  reservation_id uuid,
  job_id uuid,
  request_id text,
  provider text,
  model text,
  price_version text,
  currency text,
  reserved_micro_usd bigint,
  max_input_tokens bigint,
  max_output_tokens bigint,
  input_micro_usd_per_million bigint,
  cached_input_micro_usd_per_million bigint,
  output_micro_usd_per_million bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $get$
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Reservation unavailable' USING ERRCODE='55000';
  END IF;
  RETURN QUERY
    SELECT r.id,r.job_id,r.request_id,r.provider,r.model,
      s.price_version,s.currency,r.reserved_micro_usd,
      r.max_input_tokens,r.max_output_tokens,
      s.input_micro_usd_per_million,s.cached_micro_usd_per_million,
      s.output_micro_usd_per_million
    FROM vns.provider_live_reservations r
    JOIN vns.provider_live_price_snapshots s ON s.id=r.price_snapshot_id
    WHERE r.id=p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation unavailable' USING ERRCODE='55000';
  END IF;
END;
$get$;

-- Do not throw after setting halted, or PostgreSQL would roll back the stop.
-- One SQL transaction retains both the global halt and its immutable incident.
CREATE FUNCTION vns.halt_provider_live_budget(
  p_reservation_id uuid,p_reason text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $halt$
BEGIN
  IF p_reservation_id IS NULL OR p_reason IS NULL OR p_reason NOT IN (
    'response_missing','response_invalid','quote_over_reservation',
    'persistence_failed','settlement_unconfirmed'
  ) THEN
    RAISE EXCEPTION 'Invalid budget fault' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM vns.provider_live_budget_policy WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget policy unavailable' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM vns.provider_live_reservations WHERE id=p_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation unavailable' USING ERRCODE='55000';
  END IF;
  UPDATE vns.provider_live_budget_policy SET halted=true WHERE singleton;
  INSERT INTO vns.provider_live_worker_faults(reservation_id,reason)
    VALUES(p_reservation_id,p_reason) ON CONFLICT DO NOTHING;
  RETURN true;
END;
$halt$;

REVOKE ALL ON FUNCTION vns.get_provider_live_reservation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.halt_provider_live_budget(uuid,text) FROM PUBLIC;
ALTER FUNCTION vns.get_provider_live_reservation(uuid)
  OWNER TO vns_provider_usage_executor;
ALTER FUNCTION vns.halt_provider_live_budget(uuid,text)
  OWNER TO vns_provider_usage_executor;
GRANT EXECUTE ON FUNCTION vns.get_provider_live_reservation(uuid)
  TO vns_provider_usage_writer;
GRANT EXECUTE ON FUNCTION vns.halt_provider_live_budget(uuid,text)
  TO vns_provider_usage_writer;

COMMENT ON TABLE vns.provider_live_worker_faults IS
 'Immutable offline worker metering failures. Does not authorize spending or restore usage.';
INSERT INTO vns.schema_migrations(version)
VALUES('0038_provider_worker_budget_guard');
COMMIT;
