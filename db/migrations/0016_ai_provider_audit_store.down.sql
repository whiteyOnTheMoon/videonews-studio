-- Destructive disposable-CI-only rollback; NEVER on VPS.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0016_ai_provider_audit_store';
DROP FUNCTION vns.admin_mutate_ai_provider(text,text,text,bytea,bytea,bytea);
DROP FUNCTION vns.admin_list_ai_providers();
DROP TRIGGER reject_ai_provider_config_event_mutation ON vns.ai_provider_config_events;
DROP TRIGGER reject_ai_provider_config_event_truncate ON vns.ai_provider_config_events;
DROP TABLE vns.ai_provider_config_events;
DROP ROLE vns_provider_config_writer;
DROP ROLE vns_provider_config_executor;
COMMIT;
