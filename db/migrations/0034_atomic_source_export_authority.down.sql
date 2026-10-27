-- Stop signed-export publisher before reverting this read boundary.
BEGIN;
REVOKE EXECUTE ON FUNCTION vns.read_approved_source_export()
  FROM vns_source_export_reader;
DROP FUNCTION vns.read_approved_source_export();
REVOKE SELECT ON vns.admin_source_host_audit
  FROM vns_source_export_authority;
REVOKE SELECT, UPDATE(singleton) ON vns.admin_source_registry,
  vns.admin_source_host_approvals FROM vns_source_export_authority;
REVOKE USAGE ON SCHEMA vns
  FROM vns_source_export_authority,vns_source_export_reader;
DROP ROLE vns_source_export_reader;
DROP ROLE vns_source_export_authority;
DELETE FROM vns.schema_migrations
  WHERE version='0034_atomic_source_export_authority';
COMMIT;
