-- Independent authority only. Never run as an application migration.
BEGIN;
CREATE TABLE vns_source_anchor.trust_policy_high_water (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$')
);
REVOKE ALL ON vns_source_anchor.trust_policy_high_water FROM PUBLIC;
CREATE FUNCTION vns_source_anchor.advance_trust_policy(
  p_revision bigint,
  p_sha256 text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE affected integer;
BEGIN
  IF p_revision IS NULL OR p_revision < 1 OR p_sha256 IS NULL
    OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'trust policy admission refused' USING ERRCODE = '22023';
  END IF;
  UPDATE vns_source_anchor.trust_policy_high_water
    SET policy_revision = p_revision,
        policy_sha256 = p_sha256
    WHERE singleton = true
      AND policy_revision <= p_revision
      AND (policy_revision < p_revision OR policy_sha256 = p_sha256);
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;
REVOKE ALL ON FUNCTION vns_source_anchor.advance_trust_policy(bigint,text) FROM PUBLIC;
-- No automatic INSERT, ownership transfer, or worker grant.
-- Independent operator provisions bootstrap row and EXECUTE-only service role.
COMMIT;
