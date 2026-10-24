-- P1-07 offline-only migration. Do not apply to VPS without operator approval,
-- verified backup/restore and a validated privileged-operator enrollment flow.
BEGIN;

CREATE ROLE vns_lifecycle_audit_writer
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

-- A trusted DBA (NOT an application or provisioner) must enroll a real,
-- individually authenticated PostgreSQL LOGIN before it can change accounts.
-- An empty registry makes all account mutations fail closed after this migration.
CREATE TABLE vns.editor_operator_registry (
  login_role name PRIMARY KEY,
  operator_id uuid NOT NULL UNIQUE,
  operator_label text NOT NULL
    CHECK (length(btrim(operator_label)) BETWEEN 3 AND 100),
  active boolean NOT NULL DEFAULT false,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE vns.editor_account_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  editor_id uuid NOT NULL,
  editor_username text NOT NULL,
  operator_id uuid NOT NULL,
  operator_login name NOT NULL,
  operator_label text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('created', 'updated')),
  password_rotated boolean NOT NULL,
  role_changed boolean NOT NULL,
  active_changed boolean NOT NULL,
  display_name_changed boolean NOT NULL,
  previous_role text,
  new_role text NOT NULL,
  previous_active boolean,
  new_active boolean NOT NULL,
  previous_auth_version integer,
  new_auth_version integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (operation='created' AND previous_role IS NULL
     AND previous_active IS NULL AND previous_auth_version IS NULL)
    OR
    (operation='updated' AND previous_role IS NOT NULL
     AND previous_active IS NOT NULL AND previous_auth_version IS NOT NULL)
  )
);
CREATE INDEX editor_lifecycle_recorded_idx
  ON vns.editor_account_lifecycle_events (recorded_at DESC);

-- Never expose password_hash, old hashes or password material in the ledger.
GRANT USAGE ON SCHEMA vns TO vns_lifecycle_audit_writer;
GRANT SELECT ON vns.editor_operator_registry TO vns_lifecycle_audit_writer;
GRANT INSERT ON vns.editor_account_lifecycle_events TO vns_lifecycle_audit_writer;
GRANT SELECT ON vns.editor_account_lifecycle_events TO vns_audit_reader;

CREATE FUNCTION vns.capture_editor_account_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, vns, pg_temp
AS $audit$
DECLARE
  trusted_operator record;
  password_changed boolean := false;
  role_modified boolean := false;
  active_modified boolean := false;
  display_modified boolean := false;
BEGIN
  -- session_user is established by PostgreSQL login authentication, unlike
  -- current_user (changed by SET ROLE) or caller-controlled GUC/request JSON.
  SELECT operator_id, operator_label INTO trusted_operator
  FROM vns.editor_operator_registry
  WHERE login_role = session_user AND active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unregistered editor-account operator'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.username IS DISTINCT FROM OLD.username THEN
      RAISE EXCEPTION 'editor account identity is immutable'
        USING ERRCODE = '22023';
    END IF;
    password_changed := NEW.password_hash IS DISTINCT FROM OLD.password_hash;
    role_modified := NEW.role IS DISTINCT FROM OLD.role;
    active_modified := NEW.active IS DISTINCT FROM OLD.active;
    display_modified := NEW.display_name IS DISTINCT FROM OLD.display_name;
    IF NOT (password_changed OR role_modified OR active_modified OR display_modified) THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO vns.editor_account_lifecycle_events
    (editor_id,editor_username,operator_id,operator_login,operator_label,
     operation,password_rotated,role_changed,active_changed,display_name_changed,
     previous_role,new_role,previous_active,new_active,
     previous_auth_version,new_auth_version)
  VALUES
    (NEW.id,NEW.username,trusted_operator.operator_id,session_user,
     trusted_operator.operator_label,
     CASE WHEN TG_OP='INSERT' THEN 'created' ELSE 'updated' END,
     password_changed,role_modified,active_modified,display_modified,
     CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.role END,NEW.role,
     CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.active END,NEW.active,
     CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.auth_version END,NEW.auth_version);
  RETURN NEW;
END;
$audit$;

REVOKE ALL ON FUNCTION vns.capture_editor_account_lifecycle() FROM PUBLIC;
ALTER FUNCTION vns.capture_editor_account_lifecycle()
  OWNER TO vns_lifecycle_audit_writer;
CREATE TRIGGER capture_editor_account_lifecycle
  AFTER INSERT OR UPDATE ON vns.editor_accounts
  FOR EACH ROW EXECUTE FUNCTION vns.capture_editor_account_lifecycle();

CREATE TRIGGER prevent_editor_lifecycle_mutation
  BEFORE UPDATE OR DELETE ON vns.editor_account_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION vns.prevent_review_event_mutation();

COMMENT ON TABLE vns.editor_operator_registry IS
  'Empty by default. DBA-controlled enrollment of verified human DB login; no grants to application or provisioner.';
COMMENT ON TABLE vns.editor_account_lifecycle_events IS
  'Append-only for non-owner roles. No passwords or hashes. DB owner/superuser remains privileged.';

INSERT INTO vns.schema_migrations(version)
  VALUES ('0010_editor_account_lifecycle_audit');
COMMIT;
