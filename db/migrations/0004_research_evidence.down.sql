-- Destructive offline-only migration.
BEGIN;
DELETE FROM vns.schema_migrations WHERE version = '0004_research_evidence';
DROP TABLE vns.research_evidence;
DROP FUNCTION vns.protect_research_evidence();
COMMIT;
