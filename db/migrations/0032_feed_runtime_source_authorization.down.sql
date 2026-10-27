-- Only after an operator confirms there is no live feed runtime using this gate.
BEGIN;
DROP FUNCTION vns.feed_runtime_source_authorized(jsonb);
REVOKE SELECT ON vns.admin_source_host_audit FROM vns_feed_source_authority;
REVOKE SELECT, UPDATE(singleton) ON vns.admin_source_registry,
  vns.admin_source_host_approvals FROM vns_feed_source_authority;
REVOKE USAGE ON SCHEMA vns FROM vns_feed_source_authority;
DROP ROLE vns_feed_source_authority;
DELETE FROM vns.schema_migrations WHERE version='0032_feed_runtime_source_authorization';
COMMIT;
