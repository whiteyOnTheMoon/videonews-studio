-- P1-07: Git-only, OFFLINE; never deploy without backup/restore and operator approval.
-- These new roles are NOLOGIN with no members. Operator registry remains empty.
BEGIN;

CREATE ROLE vns_operator_governor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE vns_operator_registry_executor
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

CREATE TABLE vns.editor_operator_registry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_role name NOT NULL,
  operator_id uuid NOT NULL,
  operator_label text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('registered','revoked')),
  authorized_by name NOT NULL,
  justification text NOT NULL CHECK (
    char_length(justification) BETWEEN 20 AND 400 AND
    justification = btrim(justification) AND justification !~ '[[:cntrl:]]'
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX operator_registry_events_recorded_idx
  ON vns.editor_operator_registry_events (recorded_at DESC);

GRANT USAGE ON SCHEMA vns
  TO vns_operator_governor, vns_operator_registry_executor;
GRANT SELECT, INSERT, UPDATE (active) ON vns.editor_operator_registry
  TO vns_operator_registry_executor;
GRANT INSERT ON vns.editor_operator_registry_events
  TO vns_operator_registry_executor;
GRANT SELECT ON vns.editor_operator_registry_events TO vns_audit_reader;

CREATE FUNCTION vns.register_editor_operator(
  p_login name, p_operator_id uuid, p_label text, p_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $govern$
DECLARE
  eligible boolean;
BEGIN
  IF p_login IS NULL OR p_operator_id IS NULL OR p_label IS NULL
     OR p_reason IS NULL OR p_login = session_user
     OR char_length(p_label) NOT BETWEEN 3 AND 100
     OR p_label <> btrim(p_label) OR p_label ~ '[[:cntrl:]]'
     OR char_length(p_reason) NOT BETWEEN 20 AND 400
     OR p_reason <> btrim(p_reason) OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid registry enrollment' USING ERRCODE='22023';
  END IF;

  -- Only separately authenticated, nonprivileged LOGINs that already have
  -- the provisioner role may be enrolled. The governance login itself
  -- cannot enroll itself or an API/dispatcher login.
  SELECT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND
         NOT rolcreaterole AND NOT rolreplication
    INTO eligible FROM pg_catalog.pg_roles WHERE rolname=p_login;
  IF NOT COALESCE(eligible,false)
    OR NOT pg_catalog.pg_has_role(p_login,'vns_editor_provisioner','MEMBER')
    OR pg_catalog.pg_has_role(p_login,'vns_api_runtime','MEMBER')
    OR pg_catalog.pg_has_role(p_login,'vns_outbox_dispatcher','MEMBER')
    OR pg_catalog.pg_has_role(p_login,'vns_operator_governor','MEMBER') THEN
    RAISE EXCEPTION 'ineligible registry login' USING ERRCODE='42501';
  END IF;

  INSERT INTO vns.editor_operator_registry
    (login_role,operator_id,operator_label,active)
  VALUES (p_login,p_operator_id,p_label,true);

  INSERT INTO vns.editor_operator_registry_events
    (login_role,operator_id,operator_label,event_type,authorized_by,justification)
  VALUES (p_login,p_operator_id,p_label,'registered',session_user,p_reason);
END;
$govern$;

CREATE FUNCTION vns.revoke_editor_operator(
  p_login name, p_reason text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $govern$
DECLARE
  found_operator record;
BEGIN
  IF p_login IS NULL OR p_reason IS NULL
     OR char_length(p_reason) NOT BETWEEN 20 AND 400
     OR p_reason <> btrim(p_reason) OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'invalid registry revocation' USING ERRCODE='22023';
  END IF;

  -- Lock the target row so two concurrent revocations cannot double-log.
  SELECT operator_id,operator_label INTO found_operator
  FROM vns.editor_operator_registry
  WHERE login_role=p_login AND active=true FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'registry login not active' USING ERRCODE='22023';
  END IF;
  UPDATE vns.editor_operator_registry SET active=false WHERE login_role=p_login;
  INSERT INTO vns.editor_operator_registry_events
    (login_role,operator_id,operator_label,event_type,authorized_by,justification)
  VALUES (p_login,found_operator.operator_id,found_operator.operator_label,
          'revoked',session_user,p_reason);
END;
$govern$;

REVOKE ALL ON FUNCTION vns.register_editor_operator(name,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION vns.revoke_editor_operator(name,text) FROM PUBLIC;
ALTER FUNCTION vns.register_editor_operator(name,uuid,text,text)
  OWNER TO vns_operator_registry_executor;
ALTER FUNCTION vns.revoke_editor_operator(name,text)
  OWNER TO vns_operator_registry_executor;
GRANT EXECUTE ON FUNCTION vns.register_editor_operator(name,uuid,text,text)
  TO vns_operator_governor;
GRANT EXECUTE ON FUNCTION vns.revoke_editor_operator(name,text)
  TO vns_operator_governor;

CREATE TRIGGER prevent_operator_registry_event_mutation
  BEFORE UPDATE OR DELETE ON vns.editor_operator_registry_events
  FOR EACH ROW EXECUTE FUNCTION vns.prevent_review_event_mutation();

COMMENT ON TABLE vns.editor_operator_registry_events IS
  'Append-only for ordinary database roles. Authorizer is authenticated session_user; no MFA or human verification is supplied by the database.';
INSERT INTO vns.schema_migrations(version)
  VALUES ('0011_operator_registry_governance');
COMMIT;
