-- P1-09/#230: dormant, independently reviewed USD->EUR ceiling before reservation and claim.
-- No FX source is fetched, no rates/prices seeded, no credentials, no paid transport.
BEGIN;
CREATE TABLE vns.provider_live_fx_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  micro_eur_per_micro_usd_nanos bigint NOT NULL
    CHECK (micro_eur_per_micro_usd_nanos BETWEEN 1 AND 10000000000),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 12 AND 512),
  reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 3 AND 120),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > reviewed_at)
);
CREATE TRIGGER reject_live_fx_change
  BEFORE UPDATE OR DELETE ON vns.provider_live_fx_snapshots
  FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_live_fx_truncate
  BEFORE TRUNCATE ON vns.provider_live_fx_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

CREATE TABLE vns.provider_live_eur_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  global_cap_micro_eur bigint NOT NULL DEFAULT 0
    CHECK (global_cap_micro_eur BETWEEN 0 AND 1000000),
  active_fx_snapshot_id uuid REFERENCES vns.provider_live_fx_snapshots(id),
  CHECK (NOT enabled OR (global_cap_micro_eur BETWEEN 1 AND 1000000
                         AND active_fx_snapshot_id IS NOT NULL))
);
INSERT INTO vns.provider_live_eur_policy(singleton) VALUES(true);

-- Append-only worst-case exposure, never refunded on settlement or timeout.
-- This deliberately counts even completed requests against the 1 EUR ceiling.
CREATE TABLE vns.provider_live_eur_admissions (
  reservation_id uuid PRIMARY KEY REFERENCES vns.provider_live_reservations(id)
    ON DELETE RESTRICT,
  fx_snapshot_id uuid NOT NULL REFERENCES vns.provider_live_fx_snapshots(id),
  reserved_micro_eur bigint NOT NULL CHECK (reserved_micro_eur BETWEEN 1 AND 1000000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER reject_live_eur_admission_change
  BEFORE UPDATE OR DELETE ON vns.provider_live_eur_admissions
  FOR EACH ROW EXECUTE FUNCTION vns.reject_provider_usage_change();
CREATE TRIGGER reject_live_eur_admission_truncate
  BEFORE TRUNCATE ON vns.provider_live_eur_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION vns.reject_provider_usage_change();

-- The function owner is a NOLOGIN role, not the runtime writer.
GRANT SELECT ON vns.provider_live_fx_snapshots,
  vns.provider_live_eur_policy,vns.provider_live_eur_admissions
  TO vns_provider_usage_executor;
-- Row locking on EUR policy serializes admissions even if a future SQL
-- caller bypasses the existing USD policy lock.
GRANT UPDATE ON vns.provider_live_eur_policy TO vns_provider_usage_executor;
GRANT INSERT ON vns.provider_live_eur_admissions TO vns_provider_usage_executor;

CREATE FUNCTION vns.guard_live_provider_eur_reservation()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $eur_reserve$
DECLARE
  policy vns.provider_live_eur_policy%ROWTYPE;
  fx vns.provider_live_fx_snapshots%ROWTYPE;
  amount numeric;
  exposure numeric;
  v_checked_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO STRICT policy FROM vns.provider_live_eur_policy
    WHERE singleton FOR UPDATE;
  IF NOT policy.enabled OR policy.active_fx_snapshot_id IS NULL
    OR policy.global_cap_micro_eur NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'EUR provider budget unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT fx FROM vns.provider_live_fx_snapshots
    WHERE id=policy.active_fx_snapshot_id;
  -- An independently reviewed *upper-bound* conversion must be current.
  -- No automatic fallback to previous rates or market guesses.
  IF fx.reviewed_at > v_checked_at
    OR fx.reviewed_at < v_checked_at - interval '24 hours'
    OR fx.expires_at <= v_checked_at THEN
    RAISE EXCEPTION 'EUR FX ceiling unavailable' USING ERRCODE='42501';
  END IF;
  -- A schema upgraded after prior USD-only admissions must not ignore them.
  -- Such history has no vetted EUR basis, so freeze until separately reviewed.
  IF (SELECT count(*) FROM vns.provider_live_reservations)
    <> (SELECT count(*) FROM vns.provider_live_eur_admissions) + 1 THEN
    RAISE EXCEPTION 'Historic EUR exposure unavailable' USING ERRCODE='42501';
  END IF;
  amount := ceil(NEW.reserved_micro_usd::numeric
    * fx.micro_eur_per_micro_usd_nanos / 1000000000);
  IF amount NOT BETWEEN 1 AND policy.global_cap_micro_eur THEN
    RAISE EXCEPTION 'EUR request limit exceeded' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(sum(reserved_micro_eur),0)::numeric INTO exposure
    FROM vns.provider_live_eur_admissions;
  IF exposure + amount > policy.global_cap_micro_eur THEN
    RAISE EXCEPTION 'EUR global limit exceeded' USING ERRCODE='22023';
  END IF;
  INSERT INTO vns.provider_live_eur_admissions
    (reservation_id,fx_snapshot_id,reserved_micro_eur)
  VALUES (NEW.id,fx.id,amount::bigint);
  RETURN NEW;
EXCEPTION WHEN no_data_found THEN
  RAISE EXCEPTION 'EUR provider policy unavailable' USING ERRCODE='55000';
END;
$eur_reserve$;
-- AFTER INSERT: parent reservation must exist before FK-backed EUR receipt.
CREATE TRIGGER check_live_provider_eur_reservation
  AFTER INSERT ON vns.provider_live_reservations
  FOR EACH ROW EXECUTE FUNCTION vns.guard_live_provider_eur_reservation();

CREATE FUNCTION vns.guard_live_provider_eur_dispatch()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $eur_claim$
DECLARE
  policy vns.provider_live_eur_policy%ROWTYPE;
  fx vns.provider_live_fx_snapshots%ROWTYPE;
  admission vns.provider_live_eur_admissions%ROWTYPE;
  total numeric;
  v_checked_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO STRICT policy FROM vns.provider_live_eur_policy
    WHERE singleton FOR UPDATE;
  IF NOT policy.enabled OR policy.active_fx_snapshot_id IS NULL
    OR policy.global_cap_micro_eur NOT BETWEEN 1 AND 1000000 THEN
    RAISE EXCEPTION 'EUR dispatch unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT fx FROM vns.provider_live_fx_snapshots
    WHERE id=policy.active_fx_snapshot_id;
  SELECT * INTO STRICT admission FROM vns.provider_live_eur_admissions
    WHERE reservation_id=NEW.reservation_id;
  -- Rate rotation does not silently reprice outstanding reservations.
  -- Review/reconciliation is required before a later dispatch.
  IF fx.reviewed_at > v_checked_at
    OR fx.reviewed_at < v_checked_at - interval '24 hours'
    OR fx.expires_at <= v_checked_at
    OR admission.fx_snapshot_id <> fx.id THEN
    RAISE EXCEPTION 'EUR dispatch FX unavailable' USING ERRCODE='42501';
  END IF;
  IF (SELECT count(*) FROM vns.provider_live_reservations)
    <> (SELECT count(*) FROM vns.provider_live_eur_admissions) THEN
    RAISE EXCEPTION 'Historic EUR exposure unavailable' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(sum(reserved_micro_eur),0)::numeric INTO total
    FROM vns.provider_live_eur_admissions;
  IF total > policy.global_cap_micro_eur THEN
    RAISE EXCEPTION 'EUR dispatch cap exceeded' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
EXCEPTION WHEN no_data_found THEN
  RAISE EXCEPTION 'EUR dispatch evidence unavailable' USING ERRCODE='55000';
END;
$eur_claim$;
CREATE TRIGGER check_live_provider_eur_dispatch
  BEFORE INSERT ON vns.provider_live_dispatch_claims
  FOR EACH ROW EXECUTE FUNCTION vns.guard_live_provider_eur_dispatch();

REVOKE ALL ON FUNCTION vns.guard_live_provider_eur_reservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.guard_live_provider_eur_dispatch() FROM PUBLIC;
ALTER FUNCTION vns.guard_live_provider_eur_reservation()
  OWNER TO vns_provider_usage_executor;
ALTER FUNCTION vns.guard_live_provider_eur_dispatch()
  OWNER TO vns_provider_usage_executor;

COMMENT ON TABLE vns.provider_live_eur_policy IS
 'DISABLED, 0 EUR default. Independently reviewed conservative FX must be configured before any admission.';
COMMENT ON TABLE vns.provider_live_eur_admissions IS
 'Unrefundable immutable estimated EUR exposure at reviewed upper-bound FX; not a provider invoice.';
INSERT INTO vns.schema_migrations(version)
  VALUES('0040_provider_offline_eur_fx_guard');
COMMIT;
