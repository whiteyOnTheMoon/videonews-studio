-- Disposable CI rollback only.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0022_independent_host_approval';
DROP FUNCTION vns.admin_change_source_host_approval(bigint,bigint,text,text,text,uuid,integer);
DROP TRIGGER reject_host_audit_update ON vns.admin_source_host_audit;
DROP TRIGGER reject_host_audit_truncate ON vns.admin_source_host_audit;
DROP TABLE vns.admin_source_host_audit;
DROP TABLE vns.admin_source_host_approvals;
REVOKE SELECT,UPDATE(singleton) ON vns.admin_source_registry
  FROM vns_host_approval_executor;
REVOKE SELECT(id,username,role,active,auth_version),UPDATE(id)
  ON vns.editor_accounts FROM vns_host_approval_executor;
REVOKE USAGE ON SCHEMA vns FROM vns_host_approval_writer,vns_host_approval_executor;
DROP ROLE vns_host_approval_writer;
DROP ROLE vns_host_approval_executor;
COMMIT;
