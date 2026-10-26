-- P2-09/P2-10: identity attestation and paginated read-only timeline export.
-- Empty personal-login enrollment remains closed and production API never mounts this.
BEGIN;
CREATE FUNCTION vns.named_current_editor()
RETURNS TABLE(editor_id uuid,auth_version integer,editor_role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
BEGIN
  RETURN QUERY SELECT a.id,a.auth_version,a.role::text
  FROM vns.editor_db_principals p
  JOIN vns.editor_accounts a ON a.id=p.editor_id
  WHERE p.login_role=session_user AND p.active=true
    AND a.active=true AND a.auth_version=p.auth_version
    AND a.role IN ('admin','reviewer','editor');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal PostgreSQL login not authenticated' USING ERRCODE='42501';
  END IF;
END;
$body$;

GRANT SELECT ON vns.editorial_timeline TO vns_p2_named_executor;
CREATE FUNCTION vns.named_timeline_page(
  p_story uuid,p_after_time timestamptz,p_after_id uuid,p_limit integer
) RETURNS TABLE(
  event_id uuid,event_kind text,actor_id uuid,reference_uri text,
  document_sha256 text,details jsonb,recorded_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $body$
BEGIN
 IF NOT EXISTS(
   SELECT 1 FROM vns.editor_db_principals p
   JOIN vns.editor_accounts a ON a.id=p.editor_id
   WHERE p.login_role=session_user AND p.active=true AND a.active=true
     AND p.auth_version=a.auth_version AND a.role IN ('reviewer','admin')
 ) THEN
   RAISE EXCEPTION 'personal timeline export forbidden' USING ERRCODE='42501';
 END IF;
 IF p_story IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
   OR ((p_after_time IS NULL) <> (p_after_id IS NULL))
 THEN
   RAISE EXCEPTION 'personal timeline cursor invalid' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 SELECT t.event_id,t.event_kind,t.actor_id,t.reference_uri,
   t.document_sha256,t.details,t.recorded_at
 FROM vns.editorial_timeline t
 WHERE t.story_id=p_story AND
   (p_after_time IS NULL OR
    (t.recorded_at,t.event_id) > (p_after_time,p_after_id))
 ORDER BY t.recorded_at,t.event_id LIMIT p_limit;
END;
$body$;

REVOKE ALL ON FUNCTION vns.named_current_editor(),
 vns.named_timeline_page(uuid,timestamptz,uuid,integer) FROM PUBLIC;
ALTER FUNCTION vns.named_current_editor() OWNER TO vns_p2_named_executor;
ALTER FUNCTION vns.named_timeline_page(uuid,timestamptz,uuid,integer)
 OWNER TO vns_p2_named_executor;
GRANT EXECUTE ON FUNCTION vns.named_current_editor(),
 vns.named_timeline_page(uuid,timestamptz,uuid,integer) TO vns_p2_named_client;
INSERT INTO vns.schema_migrations(version) VALUES('0031_personal_editor_exports');
COMMIT;
