-- P2-10 offline-only identity-checked functions, intentionally no runtime grants.
BEGIN;
CREATE FUNCTION vns.append_editorial_timeline(
  p_story uuid, p_kind text, p_actor uuid, p_auth_version integer,
  p_reference text, p_digest text, p_details jsonb
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
DECLARE new_id uuid;
BEGIN
 IF p_story IS NULL OR p_actor IS NULL OR p_auth_version IS NULL
 OR p_auth_version < 0 OR p_kind IS NULL
 OR p_kind NOT IN ('source','claim','claim_rejected','review','script_revision','decision')
 OR p_details IS NULL OR jsonb_typeof(p_details) <> 'object'
 OR octet_length(p_details::text) > 8192
 THEN RAISE EXCEPTION 'timeline input invalid' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM vns.editor_accounts
 WHERE id=p_actor AND active=true AND auth_version=p_auth_version
 AND role IN ('editor','reviewer','admin') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'timeline editor not active' USING ERRCODE='42501'; END IF;
 INSERT INTO vns.editorial_timeline
 (story_id,event_kind,actor_id,reference_uri,document_sha256,details)
 VALUES (p_story,p_kind,p_actor,p_reference,p_digest,p_details)
 RETURNING event_id INTO new_id;
 RETURN new_id;
END;
$body$;
CREATE FUNCTION vns.read_editorial_timeline(
  p_story uuid, p_actor uuid, p_auth_version integer, p_limit integer
) RETURNS TABLE (
  event_id uuid, event_kind text, actor_id uuid,
  reference_uri text, document_sha256 text, details jsonb, recorded_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
BEGIN
 IF p_story IS NULL OR p_actor IS NULL OR p_auth_version IS NULL
 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
 THEN RAISE EXCEPTION 'timeline query invalid' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM vns.editor_accounts
 WHERE id=p_actor AND active=true AND auth_version=p_auth_version
 AND role IN ('reviewer','admin');
 IF NOT FOUND THEN RAISE EXCEPTION 'timeline reviewer not active' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT t.event_id,t.event_kind,t.actor_id,
 t.reference_uri,t.document_sha256,t.details,t.recorded_at
 FROM vns.editorial_timeline t WHERE t.story_id=p_story
 ORDER BY t.recorded_at,t.event_id LIMIT p_limit;
END;
$body$;
REVOKE ALL ON FUNCTION vns.append_editorial_timeline(uuid,text,uuid,integer,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.read_editorial_timeline(uuid,uuid,integer,integer) FROM PUBLIC;
-- No EXECUTE permission is granted to the API runtime.
-- A future personal LOGIN/role contract must bind session_user to p_actor.
INSERT INTO vns.schema_migrations(version) VALUES('0025_editorial_timeline_contract');
COMMIT;
