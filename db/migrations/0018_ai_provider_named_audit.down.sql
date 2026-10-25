-- CI-only reversible rollback; NEVER run on VPS.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0018_ai_provider_named_audit';
DROP FUNCTION vns.admin_mutate_ai_provider_as_editor(
  text,text,text,bytea,bytea,bytea,uuid,integer);
DROP TRIGGER reject_ai_provider_named_event_mutation ON vns.ai_provider_named_config_events;
DROP TRIGGER reject_ai_provider_named_event_truncate ON vns.ai_provider_named_config_events;
DROP TABLE vns.ai_provider_named_config_events;
REVOKE SELECT(id,username,role,active,auth_version), UPDATE(id)
  ON vns.editor_accounts FROM vns_provider_config_executor;
-- Restore exactly the former CI-only function privilege from migration 0016.
GRANT EXECUTE ON FUNCTION vns.admin_mutate_ai_provider(
  text,text,text,bytea,bytea,bytea) TO vns_provider_config_writer;
COMMIT;
