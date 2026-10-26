-- Independent authority only: outside main application migrations.
-- Run as independent, non-login authority owner after separately approved bootstrap.
BEGIN;
CREATE OR REPLACE FUNCTION vns_source_anchor.advance(
  p_source_revision bigint,
  p_host_approval_revision bigint,
  p_envelope_sha256 text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE updated_count integer;
BEGIN
  IF p_source_revision IS NULL OR p_host_approval_revision IS NULL
     OR p_source_revision < 0 OR p_host_approval_revision < 0
     OR p_envelope_sha256 IS NULL
     OR p_envelope_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'source anchor admission denied' USING ERRCODE = '22023';
  END IF;
  UPDATE vns_source_anchor.high_water
     SET source_revision = p_source_revision,
         host_approval_revision = p_host_approval_revision,
         envelope_sha256 = p_envelope_sha256
   WHERE anchor_id = 'source-export'
     AND source_revision <= p_source_revision
     AND host_approval_revision <= p_host_approval_revision
     AND (source_revision <> p_source_revision
          OR host_approval_revision <> p_host_approval_revision
          OR envelope_sha256 = p_envelope_sha256);
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END;
$$;
REVOKE ALL ON FUNCTION vns_source_anchor.advance(bigint, bigint, text) FROM PUBLIC;
-- Only independently provisioned LOGIN role is permitted EXECUTE.
-- DO NOT grant direct table privileges to the worker role.
COMMIT;
