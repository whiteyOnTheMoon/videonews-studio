-- P1-07: Git-only SQL boundary. No VPS migration without backup approval.
-- Resolve row-lock privilege without granting API account UPDATE rights.
BEGIN;

CREATE ROLE vns_editor_review_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

GRANT USAGE ON SCHEMA vns TO vns_editor_review_executor;
-- PostgreSQL SELECT ... FOR SHARE requires UPDATE permission. Only the
-- private NOLOGIN function owner gets column-scoped UPDATE(id) to lock rows.
-- The API itself never inherits this role or receives account write grants.
GRANT SELECT (id, username, role, active, auth_version)
  ON vns.editor_accounts TO vns_editor_review_executor;
GRANT UPDATE (id) ON vns.editor_accounts TO vns_editor_review_executor;
GRANT SELECT ON vns.research_evidence TO vns_editor_review_executor;
GRANT UPDATE (review_status, review_reason, reviewer_editor_id, reviewer, reviewed_at)
  ON vns.research_evidence TO vns_editor_review_executor;

CREATE FUNCTION vns.review_evidence_as_editor(
  p_evidence_id uuid, p_verdict text, p_reason text,
  p_editor_id uuid, p_auth_version integer
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $review$
DECLARE
  reviewer_name text;
  updated_id uuid;
BEGIN
  IF p_evidence_id IS NULL OR p_editor_id IS NULL OR
     p_auth_version IS NULL OR p_auth_version < 0 OR
     p_verdict IS NULL OR p_verdict NOT IN ('verified','disputed','rejected') THEN
    RAISE EXCEPTION 'invalid review arguments' USING ERRCODE = '22023';
  END IF;

  -- This lock prevents password/role/active changes from racing the verdict.
  -- The lock lasts until the caller's transaction commits.
  SELECT username INTO reviewer_name
  FROM vns.editor_accounts
  WHERE id = p_editor_id AND active = true
    AND role IN ('reviewer','admin') AND auth_version = p_auth_version
  FOR SHARE;

  IF reviewer_name IS NULL THEN RETURN 'forbidden'; END IF;

  UPDATE vns.research_evidence
  SET review_status = p_verdict, review_reason = p_reason,
      reviewer_editor_id = p_editor_id, reviewer = reviewer_name,
      reviewed_at = clock_timestamp()
  WHERE id = p_evidence_id AND review_status = 'candidate'
  RETURNING id INTO updated_id;

  IF updated_id IS NOT NULL THEN RETURN 'updated'; END IF;
  IF EXISTS (SELECT 1 FROM vns.research_evidence WHERE id = p_evidence_id) THEN
    RETURN 'already_reviewed';
  END IF;
  RETURN 'missing';
END;
$review$;

REVOKE ALL ON FUNCTION vns.review_evidence_as_editor(uuid,text,text,uuid,integer)
  FROM PUBLIC;
ALTER FUNCTION vns.review_evidence_as_editor(uuid,text,text,uuid,integer)
  OWNER TO vns_editor_review_executor;
GRANT EXECUTE ON FUNCTION vns.review_evidence_as_editor(uuid,text,text,uuid,integer)
  TO vns_api_runtime;

-- All named reviews now go via the constrained, validating SQL function.
-- Ordinary runtime credentials cannot independently forge evidence UPDATEs.
REVOKE UPDATE (review_status, reviewer, review_reason, reviewer_editor_id, reviewed_at)
  ON vns.research_evidence FROM vns_api_runtime;

COMMENT ON FUNCTION vns.review_evidence_as_editor(uuid,text,text,uuid,integer)
  IS 'Atomic named source review with locked active/versioned reviewer row; restricted API execute only.';

INSERT INTO vns.schema_migrations(version) VALUES ('0009_scoped_editor_review');
COMMIT;
