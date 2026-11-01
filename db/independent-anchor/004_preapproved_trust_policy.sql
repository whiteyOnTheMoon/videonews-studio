-- Independent PostgreSQL authority ONLY, not an application migration.
-- A worker must NEVER self-authorize an arbitrary higher signing-key digest.
-- Must be installed under separate operator custody AFTER 003, before any
-- live feed runtime starts. No approval is inserted automatically.
BEGIN;

CREATE TABLE vns_source_anchor.trust_policy_approvals (
  policy_revision bigint PRIMARY KEY CHECK (policy_revision > 0),
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON vns_source_anchor.trust_policy_approvals FROM PUBLIC;

-- Existing EXECUTE-only login may advance ONLY an out-of-band approved pair.
-- FOR SHARE holds the approval row against concurrent revocation while the
-- associated high-water update executes in the same transaction.
CREATE OR REPLACE FUNCTION vns_source_anchor.advance_trust_policy(
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

  PERFORM 1
    FROM vns_source_anchor.trust_policy_approvals
   WHERE policy_revision = p_revision AND policy_sha256 = p_sha256
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
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
-- The separately provisioned non-login owner must own both tables and the
-- SECURITY DEFINER function. Grant NO worker access to the approvals table.
COMMIT;
