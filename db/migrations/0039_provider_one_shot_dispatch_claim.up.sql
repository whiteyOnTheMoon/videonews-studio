-- P1-09 / #230: one-shot SQL dispatch claim, offline and default-off.
-- NO provider network, executable integration, credentials or VPS approval.
BEGIN;
CREATE TABLE vns.provider_live_dispatch_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE
    REFERENCES vns.provider_live_reservations(id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reject_provider_dispatch_claim_change
  BEFORE UPDATE OR DELETE ON vns.provider_live_dispatch_claims
  FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_provider_dispatch_claim_truncate
  BEFORE TRUNCATE ON vns.provider_live_dispatch_claims
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

-- The function owner is NOLOGIN and has no credential or network access.
GRANT SELECT,INSERT ON vns.provider_live_dispatch_claims
  TO vns_provider_usage_executor;

CREATE FUNCTION vns.claim_provider_live_dispatch(p_reservation_id uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $claim$
DECLARE
  policy vns.provider_live_budget_policy%ROWTYPE;
  claim_id uuid;
BEGIN
  IF p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'Invalid dispatch claim' USING ERRCODE='22023';
  END IF;

  -- All authorizations are serialized with budget changes and settlements.
  SELECT * INTO STRICT policy
    FROM vns.provider_live_budget_policy WHERE singleton FOR UPDATE;
  IF NOT policy.enabled OR policy.halted THEN
    RAISE EXCEPTION 'Provider dispatch unavailable' USING ERRCODE='42501';
  END IF;

  -- A reservation alone is insufficient: the reviewed price must remain
  -- current at claim time and a settled request must never be dispatched.
  IF NOT EXISTS (
    SELECT 1 FROM vns.provider_live_reservations r
    JOIN vns.provider_live_price_snapshots price
      ON price.id=r.price_snapshot_id
    WHERE r.id=p_reservation_id
      AND price.expires_at > clock_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM vns.provider_live_settlements settle
        WHERE settle.reservation_id=r.id
      )
  ) THEN
    RAISE EXCEPTION 'Dispatch reservation unavailable' USING ERRCODE='55000';
  END IF;

  -- First claim wins, including across distinct PostgreSQL sessions.
  -- NEVER reissue after a timeout or crash: the original provider request
  -- might have incurred spend, even with no response or receipt.
  INSERT INTO vns.provider_live_dispatch_claims(reservation_id)
    VALUES(p_reservation_id)
    ON CONFLICT (reservation_id) DO NOTHING
    RETURNING id INTO claim_id;
  RETURN claim_id;
EXCEPTION WHEN no_data_found THEN
  RAISE EXCEPTION 'Dispatch policy unavailable' USING ERRCODE='55000';
END;
$claim$;

REVOKE ALL ON FUNCTION vns.claim_provider_live_dispatch(uuid) FROM PUBLIC;
ALTER FUNCTION vns.claim_provider_live_dispatch(uuid)
  OWNER TO vns_provider_usage_executor;
GRANT EXECUTE ON FUNCTION vns.claim_provider_live_dispatch(uuid)
  TO vns_provider_usage_writer;

COMMENT ON TABLE vns.provider_live_dispatch_claims IS
 'One irreversible dispatch attempt per reservation; no automatic retry, refund, or network permission.';
INSERT INTO vns.schema_migrations(version)
VALUES ('0039_provider_one_shot_dispatch_claim');
COMMIT;
