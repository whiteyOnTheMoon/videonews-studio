-- P1-07 Git-only. Applied exclusively to disposable CI Postgres until the
-- operator approves off-host backups, migrations and account administration.
BEGIN;

ALTER TABLE vns.editor_accounts
  ADD COLUMN auth_version integer NOT NULL DEFAULT 0 CHECK (auth_version >= 0);

-- A password rotation, role change, or account toggle must invalidate all
-- previously issued sessions, even if an account is immediately reactivated.
-- Auth version cannot be set directly by the column-limited provisioner.
CREATE FUNCTION vns.bump_editor_auth_version() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.auth_version IS DISTINCT FROM OLD.auth_version THEN
    RAISE EXCEPTION 'auth version may not be assigned directly'
      USING ERRCODE = '22023';
  END IF;
  IF OLD.password_hash IS DISTINCT FROM NEW.password_hash
     OR OLD.role IS DISTINCT FROM NEW.role
     OR OLD.active IS DISTINCT FROM NEW.active THEN
    IF OLD.auth_version = 2147483647 THEN
      RAISE EXCEPTION 'auth version exhausted' USING ERRCODE = '22023';
    END IF;
    NEW.auth_version := OLD.auth_version + 1;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER bump_editor_auth_version
  BEFORE UPDATE ON vns.editor_accounts
  FOR EACH ROW EXECUTE FUNCTION vns.bump_editor_auth_version();

COMMENT ON COLUMN vns.editor_accounts.auth_version IS
  'Monotonic session revocation epoch; changes on password/role/active updates.';

INSERT INTO vns.schema_migrations(version)
  VALUES ('0008_editor_session_revocation');
COMMIT;
