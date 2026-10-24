-- Destructive, disposable CI-only rollback. Never run on live editor data.
BEGIN;
DELETE FROM vns.schema_migrations
  WHERE version = '0008_editor_session_revocation';
DROP TRIGGER bump_editor_auth_version ON vns.editor_accounts;
DROP FUNCTION vns.bump_editor_auth_version();
ALTER TABLE vns.editor_accounts DROP COLUMN auth_version;
COMMIT;
