-- Destructive CI-only rollback, before 0010 down. Not for live audit data.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0011_operator_registry_governance';
REVOKE EXECUTE ON FUNCTION vns.register_editor_operator(name,uuid,text,text)
  FROM vns_operator_governor;
REVOKE EXECUTE ON FUNCTION vns.revoke_editor_operator(name,text)
  FROM vns_operator_governor;
DROP FUNCTION vns.register_editor_operator(name,uuid,text,text);
DROP FUNCTION vns.revoke_editor_operator(name,text);
DROP TRIGGER prevent_operator_registry_event_mutation
  ON vns.editor_operator_registry_events;
REVOKE SELECT ON vns.editor_operator_registry_events FROM vns_audit_reader;
REVOKE INSERT ON vns.editor_operator_registry_events
  FROM vns_operator_registry_executor;
REVOKE SELECT, INSERT, UPDATE (active) ON vns.editor_operator_registry
  FROM vns_operator_registry_executor;
REVOKE USAGE ON SCHEMA vns
  FROM vns_operator_governor,vns_operator_registry_executor;
DROP TABLE vns.editor_operator_registry_events;
DROP ROLE vns_operator_registry_executor;
DROP ROLE vns_operator_governor;
COMMIT;
