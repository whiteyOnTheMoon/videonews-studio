-- P2-01 0022: Dormant independent host grants (disposable CI only).
-- Never deploy to VPS without backup, named login and operator acceptance.
BEGIN;
CREATE ROLE vns_host_approval_executor NOLOGIN NOINHERIT;
CREATE ROLE vns_host_approval_writer NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA vns TO vns_host_approval_executor,vns_host_approval_writer;

CREATE TABLE vns.admin_source_host_approvals (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  approved_hosts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(approved_hosts)='array' AND jsonb_array_length(approved_hosts)<=5)
);
INSERT INTO vns.admin_source_host_approvals(singleton) VALUES(true);

CREATE TABLE vns.admin_source_host_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision bigint NOT NULL UNIQUE CHECK(revision>0),
  source_revision bigint NOT NULL CHECK(source_revision>=0),
  action text NOT NULL CHECK(action IN ('grant','revoke')),
  host text NOT NULL CHECK(length(host) BETWEEN 4 AND 253),
  reason text NOT NULL CHECK(length(reason) BETWEEN 20 AND 300),
  editor_id uuid NOT NULL REFERENCES vns.editor_accounts(id) ON DELETE RESTRICT,
  editor_username text NOT NULL,
  editor_auth_version integer NOT NULL CHECK(editor_auth_version>=0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  database_login name NOT NULL DEFAULT session_user
);
CREATE TRIGGER reject_host_audit_update
  BEFORE UPDATE OR DELETE ON vns.admin_source_host_audit
  FOR EACH ROW EXECUTE FUNCTION vns.prevent_review_event_mutation();
CREATE TRIGGER reject_host_audit_truncate
  BEFORE TRUNCATE ON vns.admin_source_host_audit
  FOR EACH STATEMENT EXECUTE FUNCTION vns.prevent_review_event_mutation();

GRANT SELECT,UPDATE ON vns.admin_source_host_approvals TO vns_host_approval_executor;
GRANT INSERT ON vns.admin_source_host_audit TO vns_host_approval_executor;
GRANT USAGE ON SEQUENCE vns.admin_source_host_audit_id_seq TO vns_host_approval_executor;
GRANT SELECT(id,username,role,active,auth_version),UPDATE(id)
  ON vns.editor_accounts TO vns_host_approval_executor;
-- Share-lock the source snapshot during approval. Runtime writer gets no source table access.
GRANT SELECT,UPDATE(singleton)
  ON vns.admin_source_registry TO vns_host_approval_executor;

CREATE FUNCTION vns.admin_change_source_host_approval(
  p_expected bigint,
  p_source_revision bigint,
  p_action text,
  p_host text,
  p_reason text,
  p_editor_id uuid,
  p_auth_version integer
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,vns,pg_temp
AS $approval$
DECLARE
  v_name text;
  v_current bigint;
  v_hosts jsonb;
  v_source_revision bigint;
  v_sources jsonb;
  v_exists boolean;
  v_labels text[];
  v_label text;
BEGIN
  IF p_expected IS NULL OR p_expected<0 OR p_expected>=9007199254740991
    OR p_source_revision IS NULL OR p_source_revision<1
    OR p_action IS NULL OR p_action NOT IN ('grant','revoke')
    OR p_host IS NULL OR length(p_host) NOT BETWEEN 4 AND 253
    OR p_host !~ '^[a-z0-9-]+([.][a-z0-9-]+)*[.][a-z]{2,}$'
    OR p_host ~ '^[0-9]+([.][0-9]+){3}$'
    OR p_host ~ '[.](local|internal|localhost|onion)$'
    OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 20 AND 300
    OR p_reason<>btrim(p_reason) OR p_reason~'[[:cntrl:]]'
    OR p_editor_id IS NULL OR p_auth_version IS NULL OR p_auth_version<0
  THEN RAISE EXCEPTION 'invalid host approval' USING ERRCODE='22023'; END IF;

  v_labels:=string_to_array(p_host,'.');
  FOREACH v_label IN ARRAY v_labels LOOP
    IF length(v_label)>63 OR v_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
      OR left(v_label,4)='xn--'
    THEN RAISE EXCEPTION 'invalid approval hostname' USING ERRCODE='22023'; END IF;
  END LOOP;

  -- Resolve personal actor server-side and lock revocation state until COMMIT.
  SELECT username INTO v_name FROM vns.editor_accounts
    WHERE id=p_editor_id AND active=true AND role='admin'
      AND auth_version=p_auth_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin identity unavailable' USING ERRCODE='42501'; END IF;

  -- Read source-state revision under a shared row lock: a simultaneous source
  -- approval or block cannot race this host grant.
  SELECT revision,sources INTO v_source_revision,v_sources
    FROM vns.admin_source_registry WHERE singleton=true FOR SHARE;
  IF NOT FOUND OR v_source_revision<>p_source_revision THEN RETURN false; END IF;

  SELECT revision,approved_hosts INTO v_current,v_hosts
    FROM vns.admin_source_host_approvals WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'host approval unavailable' USING ERRCODE='55000'; END IF;
  IF v_current<>p_expected THEN RETURN false; END IF;

  IF p_action='grant' THEN
    SELECT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v_sources) AS source
      WHERE source->>'status'='approved'
        AND split_part(split_part(source->>'baseUrl','https://',2),'/',1)=p_host
    ) INTO v_exists;
    IF NOT v_exists THEN
      RAISE EXCEPTION 'host lacks independently reviewed source' USING ERRCODE='22023';
    END IF;
    IF v_hosts ? p_host OR jsonb_array_length(v_hosts)>=5 THEN
      RAISE EXCEPTION 'host already approved or grant cap reached' USING ERRCODE='22023';
    END IF;
    SELECT jsonb_agg(value ORDER BY value) INTO v_hosts
      FROM (
        SELECT value FROM jsonb_array_elements_text(v_hosts) AS value
        UNION ALL SELECT p_host
      ) AS sorted_hosts;
  ELSE
    IF NOT v_hosts ? p_host THEN
      RAISE EXCEPTION 'host is not approved' USING ERRCODE='22023';
    END IF;
    SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO v_hosts
      FROM jsonb_array_elements_text(v_hosts) AS value WHERE value<>p_host;
  END IF;

  UPDATE vns.admin_source_host_approvals
    SET revision=p_expected+1,approved_hosts=v_hosts WHERE singleton=true;
  INSERT INTO vns.admin_source_host_audit(
    revision,source_revision,action,host,reason,editor_id,editor_username,
    editor_auth_version
  ) VALUES(p_expected+1,p_source_revision,p_action,p_host,p_reason,p_editor_id,v_name,p_auth_version);
  RETURN true;
END;
$approval$;
REVOKE ALL ON FUNCTION vns.admin_change_source_host_approval(
 bigint,bigint,text,text,text,uuid,integer) FROM PUBLIC;
ALTER FUNCTION vns.admin_change_source_host_approval(
 bigint,bigint,text,text,text,uuid,integer) OWNER TO vns_host_approval_executor;
GRANT EXECUTE ON FUNCTION vns.admin_change_source_host_approval(
 bigint,bigint,text,text,text,uuid,integer) TO vns_host_approval_writer;
GRANT SELECT ON vns.admin_source_host_approvals TO vns_host_approval_writer;
COMMENT ON FUNCTION vns.admin_change_source_host_approval(
 bigint,bigint,text,text,text,uuid,integer) IS
 'Dormant personally attributed and reasoned independent host grant; trusted session binding is required at API edge.';
INSERT INTO vns.schema_migrations(version) VALUES('0022_independent_host_approval');
COMMIT;
