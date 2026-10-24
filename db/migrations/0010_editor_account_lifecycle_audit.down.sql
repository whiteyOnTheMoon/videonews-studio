-- CI-only destructive rollback, never a live audit-retention strategy.
BEGIN;
DELETE FROM vns.schema_migrations
  WHERE version='0010_editor_account_lifecycle_audit';
DROP TRIGGER capture_editor_account_lifecycle ON vns.editor_accounts;
DROP TRIGGER prevent_editor_lifecycle_mutation
  ON vns.editor_account_lifecycle_events;
DROP FUNCTION vns.capture_editor_account_lifecycle();
REVOKE SELECT ON vns.editor_account_lifecycle_events FROM vns_audit_reader;
REVOKE INSERT ON vns.editor_account_lifecycle_events FROM vns_lifecycle_audit_writer;
REVOKE SELECT ON vns.editor_operator_registry FROM vns_lifecycle_audit_writer;
REVOKE USAGE ON SCHEMA vns FROM vns_lifecycle_audit_writer;
DROP TABLE vns.editor_account_lifecycle_events;
DROP TABLE vns.editor_operator_registry;
DROP ROLE vns_lifecycle_audit_writer;
COMMIT;
