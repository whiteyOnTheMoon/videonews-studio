-- P2-01 / 0020: dormant source administration persistence. CI only; NEVER deploy automatically.
BEGIN;
CREATE ROLE vns_source_admin_executor NOLOGIN NOINHERIT;
CREATE ROLE vns_source_admin_writer NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA vns TO vns_source_admin_executor, vns_source_admin_writer;

CREATE TABLE vns.admin_source_registry (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 20)
);
INSERT INTO vns.admin_source_registry(singleton) VALUES (true);
CREATE TABLE vns.admin_source_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision bigint NOT NULL UNIQUE CHECK (revision > 0),
  source_id text NOT NULL CHECK (source_id ~ '^[a-z][a-z0-9_-]{2,40}$'),
  action text NOT NULL CHECK (action IN ('create_pending','replace_pending','approve','block','reopen')),
  editor_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  editor_username text NOT NULL,
  editor_auth_version integer NOT NULL CHECK (editor_auth_version >= 0),
  recorded_at timestamptz NOT NULL,
  database_login name NOT NULL DEFAULT session_user
);
CREATE TRIGGER reject_source_audit_update BEFORE UPDATE OR DELETE ON vns.admin_source_audit
  FOR EACH ROW EXECUTE FUNCTION vns.prevent_review_event_mutation();
CREATE TRIGGER reject_source_audit_truncate BEFORE TRUNCATE ON vns.admin_source_audit
  FOR EACH STATEMENT EXECUTE FUNCTION vns.prevent_review_event_mutation();

GRANT SELECT, UPDATE ON vns.admin_source_registry TO vns_source_admin_executor;
GRANT INSERT ON vns.admin_source_audit TO vns_source_admin_executor;
GRANT USAGE ON SEQUENCE vns.admin_source_audit_id_seq TO vns_source_admin_executor;
GRANT SELECT(id,username,role,active,auth_version), UPDATE(id)
  ON vns.editor_accounts TO vns_source_admin_executor;

CREATE FUNCTION vns.admin_commit_source_registry(
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
REVOKE ALL ON FUNCTION vns.admin_commit_source_registry(
 bigint,bigint,jsonb,text,text,uuid,integer,timestamptz) FROM PUBLIC;
ALTER FUNCTION vns.admin_commit_source_registry(
 bigint,bigint,jsonb,text,text,uuid,integer,timestamptz) OWNER TO vns_source_admin_executor;
GRANT EXECUTE ON FUNCTION vns.admin_commit_source_registry(
 bigint,bigint,jsonb,text,text,uuid,integer,timestamptz) TO vns_source_admin_writer;
GRANT SELECT ON vns.admin_source_registry TO vns_source_admin_writer;
COMMENT ON FUNCTION vns.admin_commit_source_registry(
 bigint,bigint,jsonb,text,text,uuid,integer,timestamptz) IS
 'Dormant atomic snapshot CAS + named-editor audit; upstream must validate full source schema and authenticate editor.';
INSERT INTO vns.schema_migrations(version) VALUES ('0020_source_admin_registry');
COMMIT;
