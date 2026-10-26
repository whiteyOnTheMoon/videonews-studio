-- CI-only rollback: never run on a production VPS.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0020_source_admin_registry';
DROP FUNCTION vns.admin_commit_source_registry(bigint,bigint,jsonb,text,text,uuid,integer,timestamptz);
DROP TRIGGER reject_source_audit_update ON vns.admin_source_audit;
DROP TRIGGER reject_source_audit_truncate ON vns.admin_source_audit;
DROP TABLE vns.admin_source_audit;
DROP TABLE vns.admin_source_registry;
REVOKE SELECT(id,username,role,active,auth_version), UPDATE(id)
  ON vns.editor_accounts FROM vns_source_admin_executor;
REVOKE USAGE ON SCHEMA vns FROM vns_source_admin_writer, vns_source_admin_executor;
DROP ROLE vns_source_admin_writer;
DROP ROLE vns_source_admin_executor;
COMMIT;
