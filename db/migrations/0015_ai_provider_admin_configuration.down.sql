-- Destructive disposable-CI-only rollback; never on production VPS.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0015_ai_provider_admin_configuration';
DROP TABLE vns.ai_provider_sealed_credentials;
DROP TABLE vns.ai_provider_settings;
COMMIT;
