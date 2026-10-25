-- P1-09 / 0017: offline-only, durable shared admission slots.
-- Dedicated NOLOGIN writer only; never migrate VPS without separate approval.
BEGIN;

CREATE TABLE vns.ai_provider_mutation_window (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  window_started timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)
);
INSERT INTO vns.ai_provider_mutation_window(singleton,window_started,attempts)
VALUES (true,clock_timestamp(),0);

-- The SECURITY DEFINER executor can lock/update the singleton;
-- the NOLOGIN writer gets only EXECUTE, never direct table privileges.
GRANT SELECT, UPDATE(window_started,attempts)
  ON vns.ai_provider_mutation_window TO vns_provider_config_executor;

CREATE FUNCTION vns.admin_try_ai_provider_mutation_slot()
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $admit$
DECLARE
  v_started timestamptz;
  v_attempts integer;
  v_now timestamptz;
BEGIN
  SELECT window_started, attempts INTO v_started, v_attempts
    FROM vns.ai_provider_mutation_window
   WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'provider admission unavailable' USING ERRCODE='55000';
  END IF;
  v_now := clock_timestamp();
  -- Database clock rollback never grants additional attempts.
  IF v_now < v_started THEN RETURN false; END IF;
  IF v_now - v_started >= INTERVAL '60 seconds' THEN
    UPDATE vns.ai_provider_mutation_window
       SET window_started=v_now, attempts=1
     WHERE singleton=true;
    RETURN true;
  END IF;
  IF v_attempts >= 5 THEN RETURN false; END IF;
  UPDATE vns.ai_provider_mutation_window SET attempts=v_attempts+1
   WHERE singleton=true;
  RETURN true;
END;
$admit$;

REVOKE ALL ON FUNCTION vns.admin_try_ai_provider_mutation_slot() FROM PUBLIC;
ALTER FUNCTION vns.admin_try_ai_provider_mutation_slot()
  OWNER TO vns_provider_config_executor;
GRANT EXECUTE ON FUNCTION vns.admin_try_ai_provider_mutation_slot()
  TO vns_provider_config_writer;

COMMENT ON TABLE vns.ai_provider_mutation_window IS
 'Dormant global provider mutation attempt counter; synthetic CI only; no personal identity.';
COMMENT ON FUNCTION vns.admin_try_ai_provider_mutation_slot() IS
 'CI-only atomic admission: 5 attempts per 60 seconds across database clients. Not live.';

INSERT INTO vns.schema_migrations(version)
VALUES ('0017_ai_provider_mutation_admission');
COMMIT;
