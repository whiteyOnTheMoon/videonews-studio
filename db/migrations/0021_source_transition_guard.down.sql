-- Revert this function hardening in disposable CI only; not a production rollback plan.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0021_source_transition_guard';
CREATE OR REPLACE FUNCTION vns.admin_commit_source_registry(
 p_expected bigint, p_next bigint, p_sources jsonb, p_source_id text,
 p_action text, p_editor_id uuid, p_auth_version integer, p_recorded_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $write$
DECLARE v_username text;
BEGIN
  IF p_expected IS NULL OR p_expected < 0 OR p_next IS DISTINCT FROM p_expected+1
    OR p_next > 9007199254740991 OR p_sources IS NULL
    OR jsonb_typeof(p_sources) IS DISTINCT FROM 'array' OR jsonb_array_length(p_sources) > 20
    OR p_source_id IS NULL OR p_source_id !~ '^[a-z][a-z0-9_-]{2,40}$'
    OR p_action NOT IN ('create_pending','replace_pending','approve','block','reopen')
    OR p_editor_id IS NULL OR p_auth_version IS NULL OR p_auth_version < 0
    OR p_recorded_at IS NULL
  THEN RAISE EXCEPTION 'invalid source mutation' USING ERRCODE='22023'; END IF;

  SELECT username INTO v_username FROM vns.editor_accounts
    WHERE id=p_editor_id AND role='admin' AND active=true
      AND auth_version=p_auth_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin identity unavailable' USING ERRCODE='42501'; END IF;
  UPDATE vns.admin_source_registry SET revision=p_next,sources=p_sources
    WHERE singleton=true AND revision=p_expected;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO vns.admin_source_audit
    (revision,source_id,action,editor_id,editor_username,editor_auth_version,recorded_at)
    VALUES(p_next,p_source_id,p_action,p_editor_id,v_username,p_auth_version,p_recorded_at);
  RETURN true;
END;
$write$;
COMMENT ON FUNCTION vns.admin_commit_source_registry(
 bigint,bigint,jsonb,text,text,uuid,integer,timestamptz) IS
 'Dormant atomic snapshot CAS + named-editor audit; upstream must validate full source schema and authenticate editor.';
COMMIT;
