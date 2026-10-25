-- Destructive CI-only rollback; NEVER run on VPS.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version='0017_ai_provider_mutation_admission';
DROP FUNCTION vns.admin_try_ai_provider_mutation_slot();
DROP TABLE vns.ai_provider_mutation_window;
COMMIT;
